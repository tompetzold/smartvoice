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

const API_BASE_URL = "http://127.0.0.1:8000";
const PRELOAD_CHUNK_COUNT = 3;
const PROGRAMMATIC_SCROLL_GRACE_MS = 1200;
const USER_SCROLL_SETTLE_MS = 650;

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
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [chunkAudio, setChunkAudio] = useState<Record<string, ChunkAudioResponse>>({});

  const audioRef = useRef<HTMLAudioElement | null>(null);
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
          setStatus("AutoScroll deaktiviert: aktueller Lesebereich wurde verlassen.");
        }
      }, USER_SCROLL_SETTLE_MS);
    }

    window.addEventListener("scroll", scheduleAutoScrollDisableCheck, { passive: true });

    return () => {
      window.removeEventListener("scroll", scheduleAutoScrollDisableCheck);

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

    return elements.some((element) => {
      const rect = element.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const verticallyInsideViewport = rect.bottom > 0 && rect.top < window.innerHeight;
      const horizontallyInsideViewport = rect.right > 0 && rect.left < window.innerWidth;

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

      <header className="topbar">
        <div className="topbar-title">
          <h1>SmartVoice</h1>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-logo">SV</div>

        <label className="sidebar-item file-sidebar-button">
          <span className="sidebar-icon">＋</span>
          <span className="sidebar-label">PDF</span>
          <input type="file" accept="application/pdf,.pdf" onChange={handleFileInput} />
        </label>

        <div className="sidebar-item sidebar-select-item">
          <span className="sidebar-icon">📄</span>
          <span className="sidebar-label">Datei</span>
          <select
            className="sidebar-select"
            value={documentData?.documentId ?? ""}
            onChange={(event) => {
              if (event.target.value) {
                void loadDocument(event.target.value);
              }
            }}
          >
            <option value="">Auswählen</option>
            {documents.map((document) => (
              <option value={document.documentId} key={document.documentId}>
                {document.filename}
              </option>
            ))}
          </select>
        </div>

        <div className="sidebar-item sidebar-select-item">
          <span className="sidebar-icon">●</span>
          <span className="sidebar-label">Voice</span>
          <select
            className="sidebar-select"
            value={selectedVoiceId}
            onChange={(event) => handleVoiceChange(event.target.value)}
            disabled={voices.length === 0}
          >
            {voices.length === 0 && <option value="">Keine</option>}
            {voices.map((voice) => (
              <option value={voice.id} key={voice.id}>
                {voice.name}
              </option>
            ))}
          </select>
        </div>

        <button
          className={`sidebar-item sidebar-toggle ${autoScrollEnabled ? "active" : ""}`}
          type="button"
          onClick={() => handleAutoScrollChange(!autoScrollEnabled)}
          disabled={chunks.length === 0}
        >
          <span className="sidebar-icon">⇣</span>
          <span className="sidebar-label">Auto</span>
        </button>

        <div className="sidebar-item sidebar-slider-item">
          <span className="sidebar-icon">↕</span>
          <span className="sidebar-label">{Math.round(zoom * 100)}%</span>
          <input
            className="sidebar-vertical-slider"
            type="range"
            min="35"
            max="110"
            value={Math.round(zoom * 100)}
            onChange={(event) => setZoom(Number(event.target.value) / 100)}
            aria-label="Zoom"
          />
          <span className="sidebar-small-label">Zoom</span>
        </div>

        <div className="sidebar-item sidebar-slider-item">
          <span className="sidebar-icon">×</span>
          <span className="sidebar-label">{playbackRate.toFixed(2)}x</span>
          <input
            className="sidebar-vertical-slider"
            type="range"
            min="0.1"
            max="2.0"
            step="0.05"
            value={playbackRate}
            onChange={(event) => handlePlaybackRateChange(Number(event.target.value))}
            disabled={chunks.length === 0}
            aria-label="Speed"
          />
          <span className="sidebar-small-label">Speed</span>
        </div>
      </aside>

      <section
        className={`dropzone ${isDragging ? "dragging" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <strong>PDF hier ablegen</strong>
        <span>Die Datei wird lokal gespeichert, gerendert und als Chunk-Queue vorbereitet.</span>
      </section>

      <section className="status-panel">
        <span className={isUploading || isLoadingAudio ? "spinner" : "dot"} />
        <span>{status}</span>
      </section>

      <section className="viewer">
        {pages.length === 0 && !isUploading && (
          <div className="empty-state">
            <h2>Noch keine PDF geöffnet</h2>
            <p>Zieh eine PDF-Datei in die Dropzone, wähle eine neue Datei aus oder öffne ein gespeichertes Dokument.</p>
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

      <PlayerBar
        isPlaying={isPlaying}
        isLoadingAudio={isLoadingAudio}
        hasVoice={hasVoice}
        chunkCount={chunks.length}
        currentGlobalSeconds={currentGlobalSeconds}
        estimatedTotalSeconds={estimatedTotalSeconds}
        playbackRate={playbackRate}
        onPlayPause={() => {
          void handlePlayPause();
        }}
        onSeekGlobalTime={seekToGlobalTime}
      />
    </main>
  );
}

export default App;