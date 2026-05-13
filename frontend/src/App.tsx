import {type ChangeEvent, type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import PlayerBar from "./PlayerBar";
import "./App.css";

type RenderedPage = {
  pageNumber: number;
  width: number;
  height: number;
  imageUrl: string;
};

type SentenceSegment = {
  id: string;
  text: string;
  pageNumber: number;
  pageNumbers: number[];
  wordIds: string[];
  lineBoxes: number[][];
  type: string;
  readMode: string;
  pauseAfterMs: number;
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
  sentences?: SentenceSegment[];
};

type UploadResponse = DocumentData;

type TtsResponse = {
  segmentId: string;
  audioUrl: string;
  cached: boolean;
};

const API_BASE_URL = "http://127.0.0.1:8000";

function App() {
  const [documentData, setDocumentData] = useState<DocumentData | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [status, setStatus] = useState("Keine PDF geladen.");
  const [zoom, setZoom] = useState(0.65);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pageRefs = useRef<Record<number, HTMLElement | null>>({});

  const pages = documentData?.pages ?? [];
  const sentences = documentData?.sentences ?? [];
  const activeSegment = sentences[activeSegmentIndex] ?? null;

  const pageScaleByNumber = useMemo(() => {
    const result = new Map<number, number>();

    for (const page of pages) {
      const renderedPdfScale = documentData?.renderZoom ?? 2.0;
      const imageDisplayScale = zoom;
      const scale = renderedPdfScale * imageDisplayScale;
      result.set(page.pageNumber, scale);
    }

    return result;
  }, [pages, documentData?.renderZoom, zoom]);

  useEffect(() => {
    void loadDocuments();
  }, []);

  useEffect(() => {
    if (!activeSegment) {
      return;
    }

    const pageNumber = activeSegment.pageNumber;
    const pageElement = pageRefs.current[pageNumber];

    if (!pageElement) {
      return;
    }

    pageElement.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [activeSegmentIndex, activeSegment]);

  async function loadDocuments() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/documents`);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText);
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

    try {
      stopPlayback();

      const response = await fetch(`${API_BASE_URL}/api/documents/${documentId}`);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText);
      }

      const data = (await response.json()) as DocumentData;

      setDocumentData(data);
      setActiveSegmentIndex(0);
      setStatus(`Geladen: ${data.filename} | Seiten: ${data.pageCount} | Segmente: ${data.sentences?.length ?? 0}`);
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
    setActiveSegmentIndex(0);
    stopPlayback();

    try {
      const response = await fetch(`${API_BASE_URL}/api/documents/upload`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText);
      }

      const data = (await response.json()) as UploadResponse;

      setDocumentData(data);
      setStatus(`Geladen: ${data.filename} | Seiten: ${data.pageCount} | Segmente: ${data.sentences?.length ?? 0}`);
      await loadDocuments();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Fehler: ${message}`);
    } finally {
      setIsUploading(false);
    }
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

  function stopPlayback() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }

    setIsPlaying(false);
    setIsLoadingAudio(false);
  }

  async function requestSegmentAudio(segment: SentenceSegment): Promise<string> {
    if (!documentData) {
      throw new Error("Kein Dokument geladen.");
    }

    const response = await fetch(
      `${API_BASE_URL}/api/documents/${documentData.documentId}/tts/segments/${segment.id}`,
      {
        method: "POST",
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText);
    }

    const data = (await response.json()) as TtsResponse;
    return `${API_BASE_URL}${data.audioUrl}`;
  }

  async function playSegment(index: number) {
    if (!documentData) {
      return;
    }

    const segment = sentences[index];

    if (!segment) {
      setIsPlaying(false);
      return;
    }

    setIsLoadingAudio(true);
    setActiveSegmentIndex(index);

    try {
      const audioUrl = await requestSegmentAudio(segment);

      if (!audioRef.current) {
        return;
      }

      audioRef.current.src = audioUrl;
      audioRef.current.currentTime = 0;

      await audioRef.current.play();

      setIsPlaying(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`TTS-Fehler: ${message}`);
      setIsPlaying(false);
    } finally {
      setIsLoadingAudio(false);
    }
  }

  async function handlePlayPause() {
    if (!documentData || sentences.length === 0) {
      return;
    }

    if (isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
      return;
    }

    if (audioRef.current?.src) {
      try {
        await audioRef.current.play();
        setIsPlaying(true);
        return;
      } catch {
        await playSegment(activeSegmentIndex);
        return;
      }
    }

    await playSegment(activeSegmentIndex);
  }

  async function handlePreviousSegment() {
    if (sentences.length === 0) {
      return;
    }

    const nextIndex = Math.max(0, activeSegmentIndex - 1);
    await playSegment(nextIndex);
  }

  async function handleNextSegment() {
    if (sentences.length === 0) {
      return;
    }

    const nextIndex = Math.min(sentences.length - 1, activeSegmentIndex + 1);
    await playSegment(nextIndex);
  }

  async function handleSeekSegment(index: number) {
    if (sentences.length === 0) {
      return;
    }

    const safeIndex = Math.max(0, Math.min(sentences.length - 1, index));

    if (isPlaying) {
      await playSegment(safeIndex);
      return;
    }

    setActiveSegmentIndex(safeIndex);

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
  }

  function handleAudioEnded() {
    const nextIndex = activeSegmentIndex + 1;

    if (nextIndex >= sentences.length) {
      setIsPlaying(false);
      return;
    }

    void playSegment(nextIndex);
  }

  function isPageActive(pageNumber: number): boolean {
    if (!activeSegment) {
      return false;
    }

    return activeSegment.pageNumbers.includes(pageNumber);
  }

  function renderSegmentHighlights(page: RenderedPage) {
    if (!activeSegment) {
      return null;
    }

    if (!isPageActive(page.pageNumber)) {
      return null;
    }

    const scale = pageScaleByNumber.get(page.pageNumber) ?? 1;

    return activeSegment.lineBoxes.map((box, index) => {
      const left = box[0] * scale;
      const top = box[1] * scale;
      const width = (box[2] - box[0]) * scale;
      const height = (box[3] - box[1]) * scale;

      return (
        <div
          className="active-segment-highlight"
          key={`${activeSegment.id}-${page.pageNumber}-${index}`}
          style={{
            left: `${left}px`,
            top: `${top}px`,
            width: `${width}px`,
            height: `${height}px`,
          }}
        />
      );
    });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-title">
          <h1>VoiceMaster</h1>
          <p>Lokaler PDF-Reader mit Segment-Highlighting und TTS-Player.</p>
        </div>

        <div className="toolbar">
          <select
            className="document-select"
            value={documentData?.documentId ?? ""}
            onChange={(event) => {
              if (event.target.value) {
                void loadDocument(event.target.value);
              }
            }}
          >
            <option value="">Gespeicherte PDFs</option>
            {documents.map((document) => (
              <option value={document.documentId} key={document.documentId}>
                {document.filename}
              </option>
            ))}
          </select>

          <label className="file-button">
            PDF auswählen
            <input type="file" accept="application/pdf,.pdf" onChange={handleFileInput} />
          </label>

          <div className="zoom-control">
            <span>Zoom</span>
            <input
              type="range"
              min="35"
              max="110"
              value={Math.round(zoom * 100)}
              onChange={(event) => setZoom(Number(event.target.value) / 100)}
            />
            <span>{Math.round(zoom * 100)}%</span>
          </div>
        </div>
      </header>

      <section
        className={`dropzone ${isDragging ? "dragging" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <strong>PDF hier ablegen</strong>
        <span>Die Datei wird lokal gespeichert, gerendert und als Segment-Queue vorbereitet.</span>
      </section>

      <section className="status-panel">
        <span className={isUploading ? "spinner" : "dot"} />
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
              {renderSegmentHighlights(page)}
            </div>
          </article>
        ))}
      </section>

      <PlayerBar
        audioRef={audioRef}
        activeSegment={activeSegment}
        activeSegmentIndex={activeSegmentIndex}
        segmentCount={sentences.length}
        isPlaying={isPlaying}
        isLoadingAudio={isLoadingAudio}
        onPlayPause={() => {
          void handlePlayPause();
        }}
        onPrevious={() => {
          void handlePreviousSegment();
        }}
        onNext={() => {
          void handleNextSegment();
        }}
        onSeekSegment={(index) => {
          void handleSeekSegment(index);
        }}
        onAudioEnded={handleAudioEnded}
      />
    </main>
  );
}

export default App;