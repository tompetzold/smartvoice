import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import PlayerBar from "./PlayerBar";
import "./App.css";

type RenderedPage = {
  pageNumber: number;
  width: number;
  height: number;
  imageUrl: string;
};

type ReadingUnit = {
  unitId: string;
  text: string;
  type: string;
  source: string;
  pageNumber: number;
  pageNumbers: number[];
  lineBoxes: number[][];
  wordIds: string[];
};

type TtsChunk = {
  id: string;
  text: string;
  unitIds: string[];
  units: ReadingUnit[];
  pageNumber: number;
  pageNumbers: number[];
  estimatedDuration: number;
  charCount: number;
  wordCount: number;
};

type ChunkTimingUnit = ReadingUnit & {
  start: number;
  end: number;
};

type ChunkAudioResponse = {
  chunkId: string;
  voiceId: string;
  audioUrl: string;
  duration: number;
  cached: boolean;
  text: string;
  unitIds: string[];
  units: ReadingUnit[];
  unitTimings: ChunkTimingUnit[];
  pageNumber: number;
  pageNumbers: number[];
};

type DocumentSummary = {
  documentId: string;
  filename: string;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
};

type DocumentData = {
  documentId: string;
  filename: string;
  storedPdfUrl: string;
  pageCount: number;
  renderZoom: number;
  createdAt: string;
  updatedAt: string;
  pages: RenderedPage[];
  sentences?: unknown[];
  readingUnits?: ReadingUnit[];
  chunks?: TtsChunk[];
};

type PiperVoice = {
  id: string;
  name: string;
  modelFilename: string;
  configFilename: string;
  available: boolean;
  isDefault: boolean;
};

type VoicesResponse = {
  defaultVoiceId: string;
  voices: PiperVoice[];
};

const API_BASE_URL = "http://127.0.0.1:8001";
const PRELOAD_CHUNK_COUNT = 3;
const PROGRAMMATIC_SCROLL_GRACE_MS = 1200;
const USER_SCROLL_SETTLE_MS = 650;
const ZOOM_STEPS = [0.45, 0.55, 0.65, 0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75];

function App() {
  const [documentData, setDocumentData] = useState<DocumentData | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [voices, setVoices] = useState<PiperVoice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [status, setStatus] = useState("Keine PDF geladen.");
  const [zoom, setZoom] = useState(0.65);
  const [activeChunkIndex, setActiveChunkIndex] = useState(0);
  const [activeUnitId, setActiveUnitId] = useState("");
  const [currentChunkLocalSeconds, setCurrentChunkLocalSeconds] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [volume, setVolume] = useState(1.0);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [chunkAudio, setChunkAudio] = useState<Record<string, ChunkAudioResponse>>({});

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const viewerRef = useRef<HTMLElement | null>(null);
  const zoomRef = useRef(zoom);
  const pinchAccumulatorRef = useRef(0);
  const pinchLastStepAtRef = useRef(0);
  const pageRefs = useRef<Record<number, HTMLElement | null>>({});
  const preloadInFlightRef = useRef<Set<string>>(new Set());
  const lastAutoScrolledUnitIdRef = useRef("");
  const programmaticScrollUntilRef = useRef(0);
  const userScrollTimerRef = useRef<number | null>(null);
  const activeUnitRef = useRef<ReadingUnit | null>(null);
  const autoScrollEnabledRef = useRef(true);

  const pages = documentData?.pages ?? [];
  const chunks = documentData?.chunks ?? [];
  const activeChunk = chunks[activeChunkIndex] ?? null;
  const hasVoice = voices.length > 0 && selectedVoiceId.length > 0;
  const activeChunkAudio = activeChunk ? chunkAudio[activeChunk.id] ?? null : null;

  const activeUnit = useMemo(() => {
    if (!activeChunk) {
      return null;
    }

    if (activeChunkAudio) {
      const timing = activeChunkAudio.unitTimings.find(
        (unit) => currentChunkLocalSeconds >= unit.start && currentChunkLocalSeconds < unit.end,
      );

      if (timing) {
        return timing;
      }
    }

    if (activeUnitId) {
      const unit = activeChunk.units.find((candidate) => candidate.unitId === activeUnitId);

      if (unit) {
        return unit;
      }
    }

    return activeChunk.units[0] ?? null;
  }, [activeChunk, activeChunkAudio, currentChunkLocalSeconds, activeUnitId]);

  const pageScaleByNumber = useMemo(() => {
    const result = new Map<number, number>();
    const renderedPdfScale = documentData?.renderZoom ?? 2.0;

    for (const page of pages) {
      result.set(page.pageNumber, renderedPdfScale * zoom);
    }

    return result;
  }, [pages, documentData?.renderZoom, zoom]);

  const estimatedTotalSeconds = useMemo(() => {
    let total = 0;

    for (const chunk of chunks) {
      total += chunkAudio[chunk.id]?.duration ?? chunk.estimatedDuration ?? 1;
    }

    return total;
  }, [chunks, chunkAudio]);

  const currentGlobalSeconds = useMemo(() => {
    let elapsed = 0;

    for (let index = 0; index < activeChunkIndex; index += 1) {
      const chunk = chunks[index];
      elapsed += chunkAudio[chunk.id]?.duration ?? chunk.estimatedDuration ?? 1;
    }

    elapsed += currentChunkLocalSeconds;

    return elapsed;
  }, [chunks, chunkAudio, activeChunkIndex, currentChunkLocalSeconds]);

  useEffect(() => {
    activeUnitRef.current = activeUnit;
  }, [activeUnit]);

  useEffect(() => {
    autoScrollEnabledRef.current = autoScrollEnabled;
  }, [autoScrollEnabled]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    const viewer = viewerRef.current;

    if (!viewer) {
      return;
    }

    function handlePinchZoom(event: WheelEvent) {
      if (!event.ctrlKey) {
        return;
      }

      event.preventDefault();

      if (!documentData || pages.length === 0) {
        return;
      }

      pinchAccumulatorRef.current += event.deltaY;

      const now = Date.now();

      if (Math.abs(pinchAccumulatorRef.current) < 12 || now - pinchLastStepAtRef.current < 120) {
        return;
      }

      const currentZoom = zoomRef.current;
      const currentIndex = ZOOM_STEPS.reduce((bestIndex, step, index) => {
        const bestDistance = Math.abs(ZOOM_STEPS[bestIndex] - currentZoom);
        const currentDistance = Math.abs(step - currentZoom);
        return currentDistance < bestDistance ? index : bestIndex;
      }, 0);
      const direction = pinchAccumulatorRef.current < 0 ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(ZOOM_STEPS.length - 1, currentIndex + direction));
      const nextZoom = ZOOM_STEPS[nextIndex];

      pinchAccumulatorRef.current = 0;
      pinchLastStepAtRef.current = now;

      if (nextZoom === currentZoom) {
        return;
      }

      const rect = viewer.getBoundingClientRect();
      const pointerX = event.clientX - rect.left + viewer.scrollLeft;
      const pointerY = event.clientY - rect.top + viewer.scrollTop;
      const ratio = nextZoom / currentZoom;

      zoomRef.current = nextZoom;
      setZoom(nextZoom);

      window.requestAnimationFrame(() => {
        viewer.scrollLeft = pointerX * ratio - (event.clientX - rect.left);
        viewer.scrollTop = pointerY * ratio - (event.clientY - rect.top);
      });
    }

    viewer.addEventListener("wheel", handlePinchZoom, { passive: false });

    return () => {
      viewer.removeEventListener("wheel", handlePinchZoom);
    };
  }, [documentData, pages.length]);

  useEffect(() => {
    void loadDocuments();
    void loadVoices();
  }, []);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }

    audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }

    audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!activeUnit || !autoScrollEnabled) {
      return;
    }

    if (lastAutoScrolledUnitIdRef.current === activeUnit.unitId) {
      return;
    }

    scrollToUnit(activeUnit, "smooth");
    lastAutoScrolledUnitIdRef.current = activeUnit.unitId;
  }, [activeUnit, autoScrollEnabled]);

  useEffect(() => {
    const viewer = viewerRef.current;

    if (!viewer) {
      return;
    }

    function scheduleAutoScrollDisableCheck() {
      if (!autoScrollEnabledRef.current) {
        return;
      }

      if (Date.now() < programmaticScrollUntilRef.current) {
        return;
      }

      if (userScrollTimerRef.current !== null) {
        window.clearTimeout(userScrollTimerRef.current);
      }

      userScrollTimerRef.current = window.setTimeout(() => {
        userScrollTimerRef.current = null;

        if (!autoScrollEnabledRef.current) {
          return;
        }

        if (Date.now() < programmaticScrollUntilRef.current) {
          return;
        }

        const currentActiveUnit = activeUnitRef.current;

        if (!currentActiveUnit) {
          return;
        }

        const stillVisible = isUnitActuallyVisible(currentActiveUnit.unitId);

        if (!stillVisible) {
          setAutoScrollEnabled(false);
          setStatus("Automatisch folgen deaktiviert: Lesestelle wurde manuell verlassen.");
        }
      }, USER_SCROLL_SETTLE_MS);
    }

    viewer.addEventListener("scroll", scheduleAutoScrollDisableCheck, { passive: true });

    return () => {
      viewer.removeEventListener("scroll", scheduleAutoScrollDisableCheck);

      if (userScrollTimerRef.current !== null) {
        window.clearTimeout(userScrollTimerRef.current);
        userScrollTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    function handleSpaceKey(event: KeyboardEvent) {
      if (event.code !== "Space") {
        return;
      }

      const target = event.target;

      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        return;
      }

      if (target instanceof HTMLElement && target.isContentEditable) {
        return;
      }

      if (!documentData || chunks.length === 0) {
        return;
      }

      event.preventDefault();
      void handlePlayPause();
    }

    window.addEventListener("keydown", handleSpaceKey);

    return () => {
      window.removeEventListener("keydown", handleSpaceKey);
    };
  }, [documentData, chunks.length, isPlaying, activeChunkIndex, currentChunkLocalSeconds, selectedVoiceId, playbackRate]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    function handleTimeUpdate() {
      if (!audioRef.current) {
        return;
      }

      const localTime = audioRef.current.currentTime;
      setCurrentChunkLocalSeconds(localTime);

      if (!activeChunkAudio) {
        return;
      }

      const activeTiming = activeChunkAudio.unitTimings.find((unit) => localTime >= unit.start && localTime < unit.end);

      if (activeTiming) {
        setActiveUnitId(activeTiming.unitId);
      }
    }

    function handleEnded() {
      const nextIndex = activeChunkIndex + 1;

      if (nextIndex >= chunks.length) {
        setIsPlaying(false);
        return;
      }

      void playChunk(nextIndex, 0);
    }

    function handlePlay() {
      setIsPlaying(true);
    }

    function handlePause() {
      setIsPlaying(false);
    }

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
    };
  }, [activeChunkIndex, chunks.length, activeChunkAudio]);

  function isUnitActuallyVisible(unitId: string): boolean {
    const escapedUnitId = CSS.escape(unitId);
    const elements = Array.from(document.querySelectorAll<HTMLElement>(`[data-unit-id="${escapedUnitId}"]`));

    if (elements.length === 0) {
      return false;
    }

    const viewer = viewerRef.current;
    const viewerRect = viewer?.getBoundingClientRect() ?? { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 };

    return elements.some((element) => {
      const rect = element.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const verticallyInsideViewport = rect.bottom > viewerRect.top && rect.top < viewerRect.bottom;
      const horizontallyInsideViewport = rect.right > viewerRect.left && rect.left < viewerRect.right;

      return verticallyInsideViewport && horizontallyInsideViewport;
    });
  }

  function scrollToUnit(unit: ReadingUnit, behavior: ScrollBehavior) {
    const escapedUnitId = CSS.escape(unit.unitId);
    const target = document.querySelector<HTMLElement>(`[data-unit-id="${escapedUnitId}"]`);
    const fallbackPageElement = pageRefs.current[unit.pageNumber];

    programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;

    if (target) {
      target.scrollIntoView({
        behavior,
        block: "center",
        inline: "nearest",
      });
      return;
    }

    if (fallbackPageElement) {
      fallbackPageElement.scrollIntoView({
        behavior,
        block: "center",
      });
    }
  }

  async function loadVoices() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/voices`);

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = (await response.json()) as VoicesResponse;
      setVoices(data.voices);

      const defaultVoiceExists = data.voices.some((voice) => voice.id === data.defaultVoiceId);

      if (defaultVoiceExists) {
        setSelectedVoiceId(data.defaultVoiceId);
      } else if (data.voices.length > 0) {
        setSelectedVoiceId(data.voices[0].id);
      } else {
        setSelectedVoiceId("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Fehler beim Laden der Stimmen: ${message}`);
    }
  }

  async function loadDocuments() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/documents`);

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = (await response.json()) as { documents: DocumentSummary[] };
      setDocuments(data.documents);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Fehler beim Laden gespeicherter PDFs: ${message}`);
    }
  }

  async function loadDocument(documentId: string) {
    setIsUploading(true);
    setStatus(`Öffne ${documentId} ...`);
    stopPlayback();

    try {
      const response = await fetch(`${API_BASE_URL}/api/documents/${documentId}`);

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = (await response.json()) as DocumentData;

      setDocumentData(data);
      setActiveChunkIndex(0);
      setActiveUnitId("");
      setCurrentChunkLocalSeconds(0);
      setChunkAudio({});
      preloadInFlightRef.current.clear();
      lastAutoScrolledUnitIdRef.current = "";
      programmaticScrollUntilRef.current = 0;
      setStatus(`Geladen: ${data.filename} | Seiten: ${data.pageCount} | Chunks: ${data.chunks?.length ?? 0}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Fehler: ${message}`);
    } finally {
      setIsUploading(false);
    }
  }

  async function uploadPdf(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setStatus("Fehler: Bitte eine PDF-Datei auswählen.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    setIsUploading(true);
    setStatus(`Lade und analysiere ${file.name} ...`);
    setDocumentData(null);
    setActiveChunkIndex(0);
    setActiveUnitId("");
    setCurrentChunkLocalSeconds(0);
    setChunkAudio({});
    preloadInFlightRef.current.clear();
    lastAutoScrolledUnitIdRef.current = "";
    programmaticScrollUntilRef.current = 0;
    stopPlayback();

    try {
      const response = await fetch(`${API_BASE_URL}/api/documents/upload`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = (await response.json()) as DocumentData;

      setDocumentData(data);
      setStatus(`Geladen: ${data.filename} | Seiten: ${data.pageCount} | Chunks: ${data.chunks?.length ?? 0}`);
      await loadDocuments();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Fehler: ${message}`);
    } finally {
      setIsUploading(false);
    }
  }

  async function requestChunkAudio(chunk: TtsChunk): Promise<ChunkAudioResponse> {
    if (!documentData) {
      throw new Error("Kein Dokument geladen.");
    }

    if (!selectedVoiceId) {
      throw new Error("Keine Piper-Stimme ausgewählt.");
    }

    const response = await fetch(
      `${API_BASE_URL}/api/documents/${documentData.documentId}/tts/chunks/${chunk.id}?voiceId=${encodeURIComponent(
        selectedVoiceId,
      )}`,
      {
        method: "POST",
      },
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = (await response.json()) as ChunkAudioResponse;

    setChunkAudio((previous) => ({
      ...previous,
      [data.chunkId]: data,
    }));

    return data;
  }

  async function preloadNextChunks(fromIndex: number) {
    if (!documentData || chunks.length === 0 || !selectedVoiceId) {
      return;
    }

    const nextChunks = chunks.slice(fromIndex + 1, fromIndex + 1 + PRELOAD_CHUNK_COUNT);
    const chunkIds = nextChunks
      .map((chunk) => chunk.id)
      .filter((chunkId) => !preloadInFlightRef.current.has(chunkId) && !chunkAudio[chunkId]);

    if (chunkIds.length === 0) {
      return;
    }

    for (const chunkId of chunkIds) {
      preloadInFlightRef.current.add(chunkId);
    }

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/documents/${documentData.documentId}/tts/preload-chunks?voiceId=${encodeURIComponent(
          selectedVoiceId,
        )}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            chunkIds,
          }),
        },
      );

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as {
        chunks: ChunkAudioResponse[];
      };

      setChunkAudio((previous) => {
        const next = { ...previous };

        for (const chunk of data.chunks) {
          next[chunk.chunkId] = chunk;
        }

        return next;
      });
    } finally {
      for (const chunkId of chunkIds) {
        preloadInFlightRef.current.delete(chunkId);
      }
    }
  }

  async function playChunk(index: number, startLocalSeconds: number) {
    if (!documentData || chunks.length === 0) {
      return;
    }

    if (!selectedVoiceId) {
      setStatus("Keine Piper-Stimme gefunden. Prüfe backend/data/piper_voices.");
      return;
    }

    const safeIndex = Math.max(0, Math.min(chunks.length - 1, index));
    const chunk = chunks[safeIndex];

    setIsLoadingAudio(true);
    setActiveChunkIndex(safeIndex);
    setCurrentChunkLocalSeconds(startLocalSeconds);
    setStatus(`Lade Audio für Chunk ${safeIndex + 1} / ${chunks.length} ...`);

    try {
      const data = chunkAudio[chunk.id] ?? (await requestChunkAudio(chunk));

      if (!audioRef.current) {
        return;
      }

      audioRef.current.src = `${API_BASE_URL}${data.audioUrl}`;
      audioRef.current.currentTime = Math.max(0, Math.min(data.duration, startLocalSeconds));
      audioRef.current.playbackRate = playbackRate;
      audioRef.current.volume = volume;
      audioRef.current.load();

      await audioRef.current.play();

      setIsPlaying(true);
      setStatus(
        `${data.cached ? "Aus Cache" : "Neu erzeugt"}: Chunk ${safeIndex + 1} / ${
          chunks.length
        } · Stimme: ${selectedVoiceId}`,
      );

      void preloadNextChunks(safeIndex);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`TTS-Fehler: ${message}`);
      setIsPlaying(false);
    } finally {
      setIsLoadingAudio(false);
    }
  }

  async function handlePlayPause() {
    if (!documentData || chunks.length === 0) {
      return;
    }

    if (isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
      return;
    }

    if (audioRef.current?.src && audioRef.current.currentTime > 0 && !audioRef.current.ended) {
      audioRef.current.playbackRate = playbackRate;
      await audioRef.current.play();
      setIsPlaying(true);
      return;
    }

    await playChunk(activeChunkIndex, currentChunkLocalSeconds);
  }

  function estimateUnitStartWithinChunk(chunk: TtsChunk, unitId: string): number {
    const audio = chunkAudio[chunk.id];
    const readyTiming = audio?.unitTimings.find((unit) => unit.unitId === unitId);

    if (readyTiming) {
      return readyTiming.start;
    }

    const units = chunk.units;
    const targetIndex = units.findIndex((unit) => unit.unitId === unitId);

    if (targetIndex <= 0) {
      return 0;
    }

    const duration = audio?.duration ?? chunk.estimatedDuration ?? 1;
    const weights = units.map((unit) => Math.max(1, unit.text.length));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const previousWeight = weights.slice(0, targetIndex).reduce((sum, value) => sum + value, 0);

    return duration * (previousWeight / Math.max(1, totalWeight));
  }

  function seekToUnit(unitId: string) {
    const chunkIndex = chunks.findIndex((chunk) => chunk.unitIds.includes(unitId));

    if (chunkIndex === -1) {
      return;
    }

    const chunk = chunks[chunkIndex];
    const start = estimateUnitStartWithinChunk(chunk, unitId);
    setActiveUnitId(unitId);
    void playChunk(chunkIndex, start);
  }

  function seekToGlobalTime(seconds: number) {
    if (chunks.length === 0) {
      return;
    }

    let cursor = 0;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const duration = chunkAudio[chunk.id]?.duration ?? chunk.estimatedDuration ?? 1;
      const end = cursor + duration;

      if (seconds >= cursor && seconds <= end) {
        void playChunk(index, Math.max(0, seconds - cursor));
        return;
      }

      cursor = end;
    }

    void playChunk(chunks.length - 1, 0);
  }

  function stopPlayback() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }

    setIsPlaying(false);
    setIsLoadingAudio(false);
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (file) {
      void uploadPdf(file);
    }

    event.target.value = "";
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);

    const file = event.dataTransfer.files?.[0];

    if (file) {
      void uploadPdf(file);
    }
  }

  function handleVoiceChange(nextVoiceId: string) {
    stopPlayback();
    setSelectedVoiceId(nextVoiceId);
    setChunkAudio({});
    preloadInFlightRef.current.clear();
    lastAutoScrolledUnitIdRef.current = "";
    programmaticScrollUntilRef.current = 0;
    setActiveChunkIndex(0);
    setActiveUnitId("");
    setCurrentChunkLocalSeconds(0);
    setStatus(`Stimme ausgewählt: ${nextVoiceId}`);
  }

  function handlePlaybackRateChange(rate: number) {
    setPlaybackRate(rate);

    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  }

  function handleAutoScrollChange(enabled: boolean) {
    setAutoScrollEnabled(enabled);
    autoScrollEnabledRef.current = enabled;

    if (!enabled) {
      return;
    }

    if (activeUnit) {
      scrollToUnit(activeUnit, "smooth");
      lastAutoScrolledUnitIdRef.current = activeUnit.unitId;
    }
  }

  function renderUnitHighlights(page: RenderedPage) {
    if (chunks.length === 0) {
      return null;
    }

    const pageUnits = chunks.flatMap((chunk) => chunk.units).filter((unit) => unit.pageNumbers.includes(page.pageNumber));
    const scale = pageScaleByNumber.get(page.pageNumber) ?? 1;
    const activeId = activeUnit?.unitId ?? "";

    return pageUnits.flatMap((unit) => {
      const active = unit.unitId === activeId;

      return unit.lineBoxes.map((box, index) => {
        const left = box[0] * scale;
        const top = box[1] * scale;
        const width = (box[2] - box[0]) * scale;
        const height = (box[3] - box[1]) * scale;

        return (
          <button
            className={`segment-hitbox ${active ? "active" : ""}`}
            data-unit-id={unit.unitId}
            key={`${unit.unitId}-${page.pageNumber}-${index}`}
            style={{
              left: `${left}px`,
              top: `${top}px`,
              width: `${width}px`,
              height: `${height}px`,
            }}
            title={unit.text}
            onClick={() => seekToUnit(unit.unitId)}
          />
        );
      });
    });
  }

  return (
    <main className="app-shell">
      <audio ref={audioRef} />

      <aside className="library-sidebar">
        <div className="brand-row">
          <div className="brand-mark">SV</div>
          <div className="brand-name">SmartVoice</div>
        </div>

        <label className="add-document-button">
          <span className="add-document-icon">＋</span>
          <span>Hinzufügen</span>
          <input type="file" accept="application/pdf,.pdf" onChange={handleFileInput} />
        </label>

        <nav className="library-nav" aria-label="Dokumente">
          <div className="library-section-title">Bibliothek</div>
          <div className="library-search-placeholder">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="m12.4 12.4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span>Suchen</span>
          </div>

          <div className="document-list">
            {documents.length === 0 && <div className="document-list-empty">Noch keine Dateien</div>}
            {documents.map((document) => {
              const active = document.documentId === documentData?.documentId;

              return (
                <button
                  className={`document-list-item ${active ? "active" : ""}`}
                  type="button"
                  key={document.documentId}
                  onClick={() => void loadDocument(document.documentId)}
                >
                  <span className="document-file-icon">PDF</span>
                  <span className="document-file-name">{document.filename}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </aside>

      <section className="reader-shell">
        <header className="reader-topbar">
          <div className="reader-title-group">
            <strong>{documentData?.filename ?? "SmartVoice"}</strong>
            {documentData && (
              <nav className="reader-menu" aria-label="Dokumentmenü">
                <span>Datei</span>
                <span>Ansicht</span>
                <span>Notizen</span>
                <span>Einstellungen</span>
              </nav>
            )}
          </div>

          <div className="reader-status">
            <span className={isUploading || isLoadingAudio ? "status-spinner" : "status-dot"} />
            <span>{status}</span>
          </div>
        </header>

        <section
          className={`viewer ${isDragging ? "dragging" : ""}`}
          ref={viewerRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {pages.length === 0 && !isUploading && (
            <div className="empty-state">
              <div className="empty-state-icon">＋</div>
              <h2>PDF hinzufügen</h2>
              <p>Zieh eine PDF hier hinein oder wähle links über „Hinzufügen“ eine Datei aus.</p>
              <label className="empty-add-button">
                <span>＋</span>
                <span>Hinzufügen</span>
                <input type="file" accept="application/pdf,.pdf" onChange={handleFileInput} />
              </label>
            </div>
          )}

          {isUploading && (
            <div className="loading-document">
              <span className="large-spinner" />
              <strong>PDF wird vorbereitet …</strong>
            </div>
          )}

          {pages.map((page) => (
            <article
              className="page-card"
              key={page.pageNumber}
              ref={(element) => {
                pageRefs.current[page.pageNumber] = element;
              }}
            >
              <div
                className="page-stage"
                style={{
                  width: `${page.width * zoom}px`,
                  height: `${page.height * zoom}px`,
                }}
              >
                <img
                  src={`${API_BASE_URL}${page.imageUrl}`}
                  alt={`Seite ${page.pageNumber}`}
                  style={{
                    width: `${page.width * zoom}px`,
                    height: `${page.height * zoom}px`,
                  }}
                  draggable={false}
                />
                {renderUnitHighlights(page)}
              </div>
            </article>
          ))}
        </section>
      </section>

      <PlayerBar
        isPlaying={isPlaying}
        isLoadingAudio={isLoadingAudio}
        hasVoice={hasVoice}
        chunkCount={chunks.length}
        currentGlobalSeconds={currentGlobalSeconds}
        estimatedTotalSeconds={estimatedTotalSeconds}
        playbackRate={playbackRate}
        volume={volume}
        voices={voices}
        selectedVoiceId={selectedVoiceId}
        autoScrollEnabled={autoScrollEnabled}
        onPlayPause={() => {
          void handlePlayPause();
        }}
        onSeekGlobalTime={seekToGlobalTime}
        onPlaybackRateChange={handlePlaybackRateChange}
        onVolumeChange={setVolume}
        onVoiceChange={handleVoiceChange}
        onAutoScrollChange={handleAutoScrollChange}
      />
    </main>
  );
}

export default App;