import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, PointerEvent as ReactPointerEvent } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import PdfPageCanvas from "./PdfPageCanvas";
import PlayerBar from "./PlayerBar";
import "./App.css";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type RenderedPage = {
  pageNumber: number;
  width: number;
  height: number;
  imageUrl: string;
};

type PdfWord = {
  id: string;
  text: string;
  pageNumber: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  blockNumber: number;
  lineNumber: number;
  wordNumber: number;
  skipCategories?: SkipCategory[];
};

type ReadingLineRect = {
  pageNumber: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

type ReadingUnit = {
  unitId: string;
  text: string;
  type: string;
  source: string;
  pageNumber: number;
  pageNumbers: number[];
  lineBoxes: number[][];
  lineRects?: ReadingLineRect[];
  wordIds: string[];
  words?: PdfWord[];
  paragraphId?: string;
  paragraphBreakAfter?: boolean;
  pauseAfterMs?: number;
  skipCategories?: SkipCategory[];
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
  skipCategories?: SkipCategory[];
};

type ChunkTimingUnit = ReadingUnit & {
  start: number;
  end: number;
};

type WordTiming = {
  wordId: string;
  unitId: string;
  text: string;
  pageNumber: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  start: number;
  end: number;
};

type ChunkAudioResponse = {
  chunkId: string;
  voiceId: string;
  requestedVoiceId?: string;
  audioUrl: string;
  duration: number;
  cached: boolean;
  text: string;
  unitIds: string[];
  units: ReadingUnit[];
  unitTimings: ChunkTimingUnit[];
  wordTimings?: WordTiming[];
  pageNumber: number;
  pageNumbers: number[];
};


class SkippedTtsChunkError extends Error {
  chunkId: string;

  constructor(chunkId: string, message: string) {
    super(message);
    this.name = "SkippedTtsChunkError";
    this.chunkId = chunkId;
  }
}

type DocumentSummary = {
  documentId: string;
  filename: string;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
  previewImageUrl?: string;
  previewWidth?: number;
  previewHeight?: number;
};


function readStoredSidebarDocumentOrder(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_SIDEBAR_DOCUMENT_ORDER);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function applyStoredSidebarDocumentOrder(documents: DocumentSummary[]): DocumentSummary[] {
  const storedOrder = readStoredSidebarDocumentOrder();

  if (storedOrder.length === 0) {
    return documents;
  }

  const byId = new Map(documents.map((document) => [document.documentId, document]));
  const knownIds = new Set(storedOrder);
  const newDocuments = documents.filter((document) => !knownIds.has(document.documentId));
  const orderedDocuments = storedOrder
    .map((documentId) => byId.get(documentId))
    .filter((document): document is DocumentSummary => Boolean(document));

  return [...newDocuments, ...orderedDocuments];
}

function persistSidebarDocumentOrder(documents: DocumentSummary[]): void {
  try {
    window.localStorage.setItem(
      STORAGE_SIDEBAR_DOCUMENT_ORDER,
      JSON.stringify(documents.map((document) => document.documentId)),
    );
  } catch {
    // localStorage can be unavailable in hardened/private browser contexts.
  }
}

type DocumentData = {
  documentId: string;
  filename: string;
  storedPdfUrl: string;
  pageCount: number;
  renderZoom: number;
  createdAt: string;
  updatedAt: string;
  pages: RenderedPage[];
  words?: PdfWord[];
  sentences?: unknown[];
  readingUnits?: ReadingUnit[];
  chunks?: TtsChunk[];
};

type PiperVoice = {
  id: string;
  name: string;
  provider: "piper" | "kokoro";
  variantLabel: string;
  language: string;
  quality: string;
  modelFilename: string;
  configFilename: string;
  available: boolean;
  downloaded: boolean;
  requiredBytes: number;
  requiredSizeLabel: string;
  downloadState: "idle" | "downloading" | "paused" | "ready" | "error";
  downloadProgress: number;
  downloadMessage: string;
  downloadError: string;
  downloadBytes: number;
  downloadTotalBytes: number;
  downloadBytesExact: boolean;
  isDefault: boolean;
};

type VoiceVariant = {
  id: "piper" | "kokoro";
  label: string;
};

type VoicesResponse = {
  defaultVoiceId: string;
  variants: VoiceVariant[];
  voices: PiperVoice[];
};

type SkipCategory =
  | "headings"
  | "footers"
  | "footnotes"
  | "tables"
  | "formulas"
  | "citations"
  | "urls"
  | "parentheses"
  | "squareBrackets"
  | "curlyBraces";

type SkipContentSettings = Record<SkipCategory, boolean>;
type TopMenu = "file" | "notes" | "settings" | null;
type ReaderDialog = "highlights" | "bookmarks" | "skip-content" | "rename" | null;
type CursorColor = "blue" | "pink" | "red" | "clear" | "orange";
type ThemeMode = "system" | "light" | "dark";

type Bookmark = {
  id: string;
  pageNumber: number;
  createdAt: number;
};

type TextMarkColor = "yellow" | "green" | "pink" | "purple" | "blue";

type TextHighlight = {
  id: string;
  color: TextMarkColor;
  text: string;
  wordIds: string[];
  note: string;
  createdAt: number;
};

type SelectionDraft = {
  wordIds: string[];
  text: string;
};

type SelectionMenuPosition = {
  left: number;
  top: number;
};

type PersistedReaderState = {
  pageNumber: number;
  pageOffsetRatio: number;
  activeChunkIndex: number;
  currentChunkLocalSeconds: number;
  selectedUnitId: string;
  zoom: number;
  autoScrollEnabled: boolean;
  updatedAt: number;
};

const API_BASE_URL = "http://127.0.0.1:8001";
const AUDIO_CHUNK_FADE_IN_MS = 16;
const AUDIO_CHUNK_FADE_OUT_MS = 24;

function toApiAssetUrl(relativeUrl?: string): string {
  if (!relativeUrl) {
    return "";
  }

  if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://")) {
    return relativeUrl;
  }

  return `${API_BASE_URL}${relativeUrl}`;
}
const PRELOAD_CHUNK_COUNT = 4;
const STORAGE_SELECTED_VOICE = "smartvoice:selectedVoiceId";
const STORAGE_LAST_DOCUMENT = "smartvoice:lastDocumentId";
const STORAGE_READER_PREFIX = "smartvoice:reader:";
const STORAGE_UI_SETTINGS = "smartvoice:uiSettings";
const STORAGE_BOOKMARK_PREFIX = "smartvoice:bookmarks:";
const STORAGE_HIGHLIGHT_PREFIX = "smartvoice:highlights:";
const STORAGE_SIDEBAR_COLLAPSED = "smartvoice:sidebarCollapsed";
const STORAGE_SIDEBAR_DOCUMENT_ORDER = "smartvoice:sidebarDocumentOrder";
const DOCUMENT_SWITCH_SKELETON_MIN_MS = 700;

const DEFAULT_SKIP_CONTENT_SETTINGS: SkipContentSettings = {
  headings: true,
  footers: true,
  footnotes: true,
  tables: true,
  formulas: true,
  citations: true,
  urls: true,
  parentheses: true,
  squareBrackets: true,
  curlyBraces: true,
};

const SKIP_CATEGORY_LABELS: Record<SkipCategory, { title: string; subtitle: string }> = {
  headings: { title: "Überschriften", subtitle: "Titel, Autor und vieles mehr" },
  footers: { title: "Fußzeilen", subtitle: "Seitenzahlen und laufende Kopf-/Fußzeilen" },
  footnotes: { title: "Fußnoten", subtitle: "Kleine Anmerkungen am Seitenende" },
  tables: { title: "Tabellen", subtitle: "| ABC | 123 |" },
  formulas: { title: "Formeln", subtitle: "f = v / λ" },
  citations: { title: "Zitate", subtitle: "(Autor, 1995)" },
  urls: { title: "URLs", subtitle: "site.com/..." },
  parentheses: { title: "geklammerter Ausdruck", subtitle: "(einige Texte)" },
  squareBrackets: { title: "Klammern", subtitle: "[ein paar Texte]" },
  curlyBraces: { title: "Klammern", subtitle: "{xyz123}" },
};

const THEME_PREFERENCE_VERSION = 1;

type StoredUiSettings = {
  themePreferenceVersion: number;
  themeMode: ThemeMode;
  cursorColor: CursorColor;
  sentenceHighlightEnabled: boolean;
  clickToReadEnabled: boolean;
  showStatusInformation: boolean;
  skipContent: SkipContentSettings;
};

function readStoredUiSettings(): StoredUiSettings {
  const fallback: StoredUiSettings = {
    themePreferenceVersion: THEME_PREFERENCE_VERSION,
    themeMode: "system",
    cursorColor: "blue",
    sentenceHighlightEnabled: true,
    clickToReadEnabled: true,
    showStatusInformation: false,
    skipContent: { ...DEFAULT_SKIP_CONTENT_SETTINGS },
  };

  try {
    const raw = window.localStorage.getItem(STORAGE_UI_SETTINGS);
    if (!raw) {
      return fallback;
    }

    const parsed = JSON.parse(raw) as Partial<StoredUiSettings>;
    const storedThemeMode: ThemeMode = ["system", "light", "dark"].includes(String(parsed.themeMode))
      ? (parsed.themeMode as ThemeMode)
      : fallback.themeMode;

    const themeMode =
      parsed.themePreferenceVersion === THEME_PREFERENCE_VERSION
        ? storedThemeMode
        : storedThemeMode === "light"
          ? "system"
          : storedThemeMode;

    return {
      themePreferenceVersion: THEME_PREFERENCE_VERSION,
      themeMode,
      cursorColor: ["blue", "pink", "red", "clear", "orange"].includes(String(parsed.cursorColor))
        ? (parsed.cursorColor as CursorColor)
        : fallback.cursorColor,
      sentenceHighlightEnabled:
        typeof parsed.sentenceHighlightEnabled === "boolean"
          ? parsed.sentenceHighlightEnabled
          : fallback.sentenceHighlightEnabled,
      clickToReadEnabled:
        typeof parsed.clickToReadEnabled === "boolean"
          ? parsed.clickToReadEnabled
          : fallback.clickToReadEnabled,
      showStatusInformation:
        typeof parsed.showStatusInformation === "boolean"
          ? parsed.showStatusInformation
          : fallback.showStatusInformation,
      skipContent: {
        ...fallback.skipContent,
        ...(parsed.skipContent ?? {}),
      },
    };
  } catch {
    return fallback;
  }
}

function enabledSkipCategories(settings: SkipContentSettings): SkipCategory[] {
  return (Object.keys(settings) as SkipCategory[]).filter((category) => settings[category]);
}

function skipProfileKey(settings: SkipContentSettings): string {
  const categories = enabledSkipCategories(settings);
  return categories.length > 0 ? categories.sort().join(",") : "none";
}

function wordShouldBeSkipped(word: PdfWord, settings: SkipContentSettings): boolean {
  return (word.skipCategories ?? []).some((category) => settings[category]);
}

function chunkShouldBeSkipped(chunk: TtsChunk, settings: SkipContentSettings): boolean {
  const words = chunk.units.flatMap((unit) => unit.words ?? []);

  if (words.length > 0) {
    return words.every((word) => wordShouldBeSkipped(word, settings));
  }

  return (chunk.skipCategories ?? []).some((category) => settings[category]);
}

function estimatedPlayableDuration(chunk: TtsChunk, settings: SkipContentSettings): number {
  const words = chunk.units.flatMap((unit) => unit.words ?? []);
  const base = chunk.estimatedDuration ?? 1;

  if (words.length === 0) {
    return base;
  }

  const playableCount = words.filter((word) => !wordShouldBeSkipped(word, settings)).length;
  if (playableCount <= 0) {
    return 0;
  }

  return Math.max(0.35, base * (playableCount / words.length));
}

function findPlayableChunkIndex(
  chunks: TtsChunk[],
  startIndex: number,
  direction: 1 | -1,
  settings: SkipContentSettings,
): number {
  let index = Math.max(0, Math.min(chunks.length - 1, startIndex));

  while (index >= 0 && index < chunks.length) {
    if (!chunkShouldBeSkipped(chunks[index], settings)) {
      return index;
    }
    index += direction;
  }

  return -1;
}

const PROGRAMMATIC_SCROLL_GRACE_MS = 1200;
const USER_SCROLL_SETTLE_MS = 650;
const ZOOM_STEPS = [0.45, 0.55, 0.65, 0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75];

function createGenerationSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildAudioCacheKey(
  voiceId: string,
  chunkId: string,
  settings: SkipContentSettings,
): string {
  return `${voiceId}::${chunkId}::skip=${skipProfileKey(settings)}`;
}

function readStoredReaderState(documentId: string): PersistedReaderState | null {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_READER_PREFIX}${documentId}`);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedReaderState>;

    if (typeof parsed.pageNumber !== "number" || typeof parsed.activeChunkIndex !== "number") {
      return null;
    }

    return {
      pageNumber: Math.max(1, Math.floor(parsed.pageNumber)),
      pageOffsetRatio: Math.max(0, Math.min(1, Number(parsed.pageOffsetRatio) || 0)),
      activeChunkIndex: Math.max(0, Math.floor(parsed.activeChunkIndex)),
      currentChunkLocalSeconds: Math.max(0, Number(parsed.currentChunkLocalSeconds) || 0),
      selectedUnitId: typeof parsed.selectedUnitId === "string" ? parsed.selectedUnitId : "",
      zoom: ZOOM_STEPS.includes(Number(parsed.zoom)) ? Number(parsed.zoom) : 0.65,
      autoScrollEnabled: typeof parsed.autoScrollEnabled === "boolean" ? parsed.autoScrollEnabled : true,
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

function documentProgressPercent(document: DocumentSummary): number {
  const persisted = readStoredReaderState(document.documentId);
  if (!persisted || document.pageCount <= 1) {
    return persisted ? 100 : 0;
  }

  const completedPages = Math.max(0, Math.min(document.pageCount - 1, persisted.pageNumber - 1));
  return Math.max(0, Math.min(100, Math.round((completedPages / (document.pageCount - 1)) * 100)));
}

function documentHistoryTimestamp(document: DocumentSummary): number {
  const persisted = readStoredReaderState(document.documentId);
  const metadataTimestamp = Date.parse(document.updatedAt || document.createdAt);
  return Math.max(persisted?.updatedAt ?? 0, Number.isFinite(metadataTimestamp) ? metadataTimestamp : 0);
}

function formatLibraryDate(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "–";
  }

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(date);
  }

  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "short",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  }).format(date);
}

function libraryGroupLabel(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Älter";
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.floor((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000);

  if (dayDifference <= 0) {
    return "Heute";
  }
  if (dayDifference <= 7) {
    return "Letzte 7 Tage";
  }

  return new Intl.DateTimeFormat("de-DE", {
    month: "long",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  }).format(date);
}


function SmartVoiceWordmark() {
  return (
    <svg
      className="brand-wordmark"
      viewBox="0 0 514.027 75.094"
      role="img"
      aria-label="SmartVoice"
      preserveAspectRatio="xMinYMid meet"
    >
      <path d="M28.188 75.094 C44.688 75.094 55.375 66.5 55.375 53.406 C55.375 43.016 48.641 36.719 34.047 33.25 L26.172 31.391 C16.172 29 12.266 25.969 12.266 20.703 C12.266 14.109 18.469 9.469 27.25 9.469 C36.438 9.469 42.391 14.594 42.922 22.938 L53.422 22.938 C52.984 8.734 43.078 0 27.406 0 C11.781 0 1.469 8.438 1.469 21.234 C1.469 31.297 7.922 37.391 22.609 40.859 L30.578 42.766 C40.688 45.156 44.531 48.391 44.531 54 C44.531 61.078 38.047 65.625 28.188 65.625 C17.297 65.625 10.891 59.953 10.844 50.344 L0 50.344 C0 65.719 10.75 75.094 28.188 75.094 Z M64.852 73.922 L75.148 73.922 L75.148 42.812 C75.148 34.656 80.523 30.359 86.523 30.359 C92.383 30.359 96.633 34.266 96.633 40.188 L96.633 73.922 L106.789 73.922 L106.789 41.688 C106.789 35.109 111.039 30.359 117.93 30.359 C123.492 30.359 128.273 33.484 128.273 40.859 L128.273 73.922 L138.633 73.922 L138.633 39.984 C138.633 27.578 131.008 21.328 121.445 21.328 C113.82 21.328 107.867 25.281 105.086 30.859 C102.93 25.344 97.273 21.328 90.242 21.328 C83.852 21.328 78.039 24.656 74.867 31 L74.867 22.359 L64.852 22.359 L64.852 73.922 Z M165.971 74.75 C174.861 74.75 179.064 70.75 181.205 66.594 L181.408 66.594 L181.408 73.922 L191.564 73.922 L191.564 38.562 C191.564 28.078 183.799 21.328 171.096 21.328 C158.205 21.328 149.861 28.266 149.377 38.078 L159.486 38.078 C159.877 33.344 164.361 29.781 170.955 29.781 C177.502 29.781 181.361 33.391 181.361 38.375 L181.361 38.812 C181.361 42.578 178.127 42.469 168.471 43.641 C157.971 44.875 148.096 47.406 148.096 59.172 C148.096 69.484 155.721 74.75 165.971 74.75 Z M168.08 66.453 C162.064 66.453 158.361 63.812 158.361 59.375 C158.361 54.141 163.439 52.141 169.049 51.312 C174.518 50.531 179.986 49.703 181.408 48.578 L181.408 54.641 C181.408 60.984 177.158 66.453 168.08 66.453 Z M203.182 73.922 L213.479 73.922 L213.479 43.453 C213.479 35.047 218.213 31.094 224.025 31.094 C226.416 31.094 228.666 31.438 229.447 31.594 L229.447 21.969 C228.619 21.875 227.26 21.719 225.697 21.719 C219.15 21.719 215.15 25.094 213.244 30.703 L213.041 30.703 L213.041 22.359 L203.182 22.359 L203.182 73.922 Z M261.977 22.359 L251.523 22.359 L251.523 8.297 L241.164 8.297 L241.164 22.359 L232.086 22.359 L232.086 30.859 L241.164 30.859 L241.164 61.609 C241.164 69.922 245.805 73.922 255.477 73.922 L261.977 73.922 L261.977 65.422 L256.945 65.422 C252.836 65.422 251.523 64.109 251.523 60.297 L251.523 30.859 L261.977 30.859 L261.977 22.359 Z M291.516 73.922 L304.547 73.922 L330.578 1.172 L319.094 1.172 L305.078 42.188 C303.328 47.453 301.125 54.484 298.203 64.062 C295.172 54.484 292.922 47.453 291.172 42.188 L276.766 1.172 L265.094 1.172 L291.516 73.922 Z M359.387 75.094 C374.121 75.094 384.043 64.109 384.043 48.234 C384.043 32.266 374.121 21.188 359.387 21.188 C344.637 21.188 334.668 32.266 334.668 48.234 C334.668 64.109 344.637 75.094 359.387 75.094 Z M359.387 66.203 C350.543 66.203 345.121 59.219 345.121 48.234 C345.121 37.156 350.59 30.078 359.387 30.078 C368.168 30.078 373.637 37.156 373.637 48.234 C373.637 59.172 368.215 66.203 359.387 66.203 Z M393.172 73.922 L403.469 73.922 L403.469 22.359 L393.172 22.359 L393.172 73.922 Z M398.297 13.469 C401.953 13.469 404.844 10.688 404.844 7.172 C404.844 3.609 401.953 0.828 398.297 0.828 C394.641 0.828 391.797 3.609 391.797 7.172 C391.797 10.688 394.641 13.469 398.297 13.469 Z M437.158 75.094 C449.471 75.094 458.549 66.984 459.721 56.25 L449.33 56.25 C447.955 62.25 444.299 66.203 437.221 66.203 C428.283 66.203 423.002 59.172 423.002 48.234 C423.002 37.203 428.33 30.078 437.221 30.078 C444.189 30.078 448.393 34.172 449.471 39.984 L459.721 39.984 C458.455 29.047 449.471 21.188 437.158 21.188 C422.471 21.188 412.549 32.375 412.549 48.234 C412.549 64.016 422.424 75.094 437.158 75.094 Z M490.48 75.094 C502.152 75.094 511.34 68.203 513.246 58.25 L503.324 58.25 C501.855 63.125 497.371 66.5 490.637 66.5 C481.605 66.5 476.418 60.203 476.074 50.922 L514.027 50.922 L514.027 48.141 C514.027 32.219 504.543 21.188 489.949 21.188 C475.887 21.188 465.918 32.516 465.918 48.234 C465.918 63.812 475.199 75.094 490.48 75.094 Z M476.184 43.109 C477.059 34.906 482.277 29.781 490.043 29.781 C497.855 29.781 503.137 34.906 503.965 43.109 L476.184 43.109 Z" fill="currentColor" />
    </svg>
  );
}

function formatSelectionNoteDate(date = new Date()): string {
  const months = [
    "Jan.",
    "Feb.",
    "Mar.",
    "Apr.",
    "May",
    "Jun.",
    "Jul.",
    "Aug.",
    "Sept.",
    "Oct.",
    "Nov.",
    "Dec.",
  ];

  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function App() {
  const [documentData, setDocumentData] = useState<DocumentData | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [voices, setVoices] = useState<PiperVoice[]>([]);
  const [voiceVariants, setVoiceVariants] = useState<VoiceVariant[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [status, setStatus] = useState("Keine PDF geladen.");
  const [zoom, setZoom] = useState(0.65);
  const [activeChunkIndex, setActiveChunkIndex] = useState(0);
  const [, setActiveUnitId] = useState("");
  const [selectedUnitId, setSelectedUnitId] = useState("");
  const [hoveredUnitId, setHoveredUnitId] = useState("");
  const [currentChunkLocalSeconds, setCurrentChunkLocalSeconds] = useState(0);
  const [activeWordTiming, setActiveWordTiming] = useState<WordTiming | null>(null);
  const [viewportPageNumber, setViewportPageNumber] = useState(1);
  const [visiblePageNumbers, setVisiblePageNumbers] = useState<number[]>([1]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playerVisible, setPlayerVisible] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [volume, setVolume] = useState(1.0);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [chunkAudio, setChunkAudio] = useState<Record<string, ChunkAudioResponse>>({});
  const initialUiSettings = useMemo(() => readStoredUiSettings(), []);
  const [topMenu, setTopMenu] = useState<TopMenu>(null);
  const [readerDialog, setReaderDialog] = useState<ReaderDialog>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialUiSettings.themeMode);
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true,
  );
  const [appearanceMenuOpen, setAppearanceMenuOpen] = useState(false);
  const [cursorColor, setCursorColor] = useState<CursorColor>(initialUiSettings.cursorColor);
  const [sentenceHighlightEnabled, setSentenceHighlightEnabled] = useState(initialUiSettings.sentenceHighlightEnabled);
  const [clickToReadEnabled, setClickToReadEnabled] = useState(initialUiSettings.clickToReadEnabled);
  const [showStatusInformation, setShowStatusInformation] = useState(initialUiSettings.showStatusInformation);
  const [skipContentSettings, setSkipContentSettings] = useState<SkipContentSettings>(initialUiSettings.skipContent);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [renameValue, setRenameValue] = useState("");
  const [textHighlights, setTextHighlights] = useState<TextHighlight[]>([]);
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const [selectionMenuPosition, setSelectionMenuPosition] = useState<SelectionMenuPosition | null>(null);
  const [selectionNoteOpen, setSelectionNoteOpen] = useState(false);
  const [selectionNoteText, setSelectionNoteText] = useState("");
  const [selectionNoteColor, setSelectionNoteColor] = useState<TextMarkColor>("yellow");
  const [selectionNoteColorOpen, setSelectionNoteColorOpen] = useState(false);
  const [selectionCopied, setSelectionCopied] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED) === "1";
    } catch {
      return false;
    }
  });
  const [addDocumentDialogOpen, setAddDocumentDialogOpen] = useState(false);
  const [draggedDocumentId, setDraggedDocumentId] = useState("");
  const [documentDragPreviewPosition, setDocumentDragPreviewPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [documentDragPreviewMetrics, setDocumentDragPreviewMetrics] = useState<{
    offsetX: number;
    offsetY: number;
    width: number;
  }>({
    offsetX: 0,
    offsetY: 0,
    width: 248,
  });
  const [openingDocumentId, setOpeningDocumentId] = useState("");
  const [openingDocumentFilename, setOpeningDocumentFilename] = useState("");
  const [pdfDocumentId, setPdfDocumentId] = useState("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackRateRef = useRef(1.0);
  const volumeRef = useRef(1.0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const audioGainNodeRef = useRef<GainNode | null>(null);
  const viewerRef = useRef<HTMLElement | null>(null);
  const zoomRef = useRef(zoom);
  const pinchAccumulatorRef = useRef(0);
  const pinchLastStepAtRef = useRef(0);
  const pageRefs = useRef<Record<number, HTMLElement | null>>({});
  const preloadInFlightRef = useRef<Set<string>>(new Set());
  const chunkAudioRef = useRef<Record<string, ChunkAudioResponse>>({});
  const lastAutoScrolledUnitIdRef = useRef("");
  const programmaticScrollUntilRef = useRef(0);
  const userScrollTimerRef = useRef<number | null>(null);
  const activeUnitRef = useRef<ReadingUnit | null>(null);
  const autoScrollEnabledRef = useRef(true);
  const playbackAnimationFrameRef = useRef<number | null>(null);
  const selectedVoiceIdRef = useRef("");
  const documentDataRef = useRef<DocumentData | null>(null);
  const activeChunkIndexRef = useRef(0);
  const currentChunkLocalSecondsRef = useRef(0);
  const selectedUnitIdRef = useRef("");
  const generationSessionRef = useRef(createGenerationSessionId());
  const requestControllersRef = useRef<Set<AbortController>>(new Set());
  const playbackAttemptRef = useRef(0);
  const pendingScrollRestoreRef = useRef<(PersistedReaderState & { documentId: string }) | null>(null);
  const readerPersistTimerRef = useRef<number | null>(null);
  const lastReaderPersistAtRef = useRef(0);
  const skipContentSettingsRef = useRef<SkipContentSettings>(skipContentSettings);
  const selectionAnchorWordIdRef = useRef("");
  const selectionDidDragRef = useRef(false);
  const selectionDraftRef = useRef<SelectionDraft | null>(null);
  const selectionFocusWordIdRef = useRef("");
  const activeWordIdRef = useRef("");
  const lastPlaybackUiUpdateAtRef = useRef(0);
  const viewportPageNumberRef = useRef(1);
  const pageVisibilityRef = useRef<Record<number, boolean>>({});
  const readerMenuRef = useRef<HTMLElement | null>(null);
  const documentItemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const documentListRef = useRef<HTMLDivElement | null>(null);
  const documentDropTargetRef = useRef<{
    documentId: string;
    position: "before" | "after";
  } | null>(null);
  const documentPointerDragRef = useRef<{
    pointerId: number;
    documentId: string;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const documentLoadAbortRef = useRef<AbortController | null>(null);
  const documentLoadRequestRef = useRef(0);
  const openingDocumentStartedAtRef = useRef(0);
  const suppressDocumentClickUntilRef = useRef(0);

  const pages = documentData?.pages ?? [];
  const chunks = documentData?.chunks ?? [];

  const pdfRenderPlan = useMemo(() => {
    const plan = new Map<number, 0 | 1>();
    const pageCount = pages.length;

    if (pageCount === 0) {
      return plan;
    }

    const normalizedVisiblePages = visiblePageNumbers
      .filter((pageNumber) => pageNumber >= 1 && pageNumber <= pageCount)
      .sort((left, right) => left - right);

    const effectiveVisiblePages =
      normalizedVisiblePages.length > 0
        ? normalizedVisiblePages
        : [
            Math.max(
              1,
              Math.min(pageCount, viewportPageNumber),
            ),
          ];

    for (const pageNumber of effectiveVisiblePages) {
      plan.set(pageNumber, 0);
    }

    for (const pageNumber of effectiveVisiblePages) {
      const previousPage = pageNumber - 1;
      const nextPage = pageNumber + 1;

      if (previousPage >= 1 && !plan.has(previousPage)) {
        plan.set(previousPage, 1);
      }

      if (nextPage <= pageCount && !plan.has(nextPage)) {
        plan.set(nextPage, 1);
      }
    }

    return plan;
  }, [pages.length, visiblePageNumbers, viewportPageNumber]);

  const activeChunk = chunks[activeChunkIndex] ?? null;
  const hasVoice = voices.length > 0 && selectedVoiceId.length > 0;
  const activeChunkAudio =
    activeChunk && selectedVoiceId
      ? chunkAudio[buildAudioCacheKey(selectedVoiceId, activeChunk.id, skipContentSettings)] ?? null
      : null;

  const libraryDocumentGroups = useMemo(() => {
    const groups: Array<{ label: string; documents: DocumentSummary[] }> = [];
    const orderedDocuments = [...documents].sort(
      (left, right) => documentHistoryTimestamp(right) - documentHistoryTimestamp(left),
    );

    for (const document of orderedDocuments) {
      const label = libraryGroupLabel(documentHistoryTimestamp(document));
      const lastGroup = groups[groups.length - 1];
      if (lastGroup?.label === label) {
        lastGroup.documents.push(document);
      } else {
        groups.push({ label, documents: [document] });
      }
    }

    return groups;
  }, [documents, documentData?.documentId]);

  const activeUnit = useMemo(() => {
    // CHUNKING_VERSION 4 maps exactly one logical sentence to one audio chunk.
    // Therefore the highlighted sentence is derived from the active chunk itself
    // instead of from an estimated time range. This removes sentence drift.
    return activeChunk?.units[0] ?? null;
  }, [activeChunk]);

  const pageScaleByNumber = useMemo(() => {
    const result = new Map<number, number>();
    const renderedPdfScale = documentData?.renderZoom ?? 2.0;

    for (const page of pages) {
      result.set(page.pageNumber, renderedPdfScale * zoom);
    }

    return result;
  }, [pages, documentData?.renderZoom, zoom]);

  const orderedWords = useMemo(() => {
    if (documentData?.words && documentData.words.length > 0) {
      return documentData.words;
    }

    const seen = new Set<string>();
    const result: PdfWord[] = [];

    for (const chunk of chunks) {
      for (const unit of chunk.units) {
        for (const word of unit.words ?? []) {
          if (!seen.has(word.id)) {
            seen.add(word.id);
            result.push(word);
          }
        }
      }
    }

    return result.sort((left, right) =>
      left.pageNumber - right.pageNumber ||
      left.blockNumber - right.blockNumber ||
      left.lineNumber - right.lineNumber ||
      left.wordNumber - right.wordNumber
    );
  }, [documentData?.words, chunks]);

  const wordById = useMemo(() => {
    const result = new Map<string, PdfWord>();
    for (const word of orderedWords) {
      result.set(word.id, word);
    }
    return result;
  }, [orderedWords]);

  const wordsByPage = useMemo(() => {
    const result = new Map<number, PdfWord[]>();
    for (const word of orderedWords) {
      const pageWords = result.get(word.pageNumber) ?? [];
      pageWords.push(word);
      result.set(word.pageNumber, pageWords);
    }
    return result;
  }, [orderedWords]);

  const unitsByPage = useMemo(() => {
    const result = new Map<number, ReadingUnit[]>();

    for (const chunk of chunks) {
      for (const unit of chunk.units) {
        for (const pageNumber of unit.pageNumbers) {
          const pageUnits = result.get(pageNumber) ?? [];
          pageUnits.push(unit);
          result.set(pageNumber, pageUnits);
        }
      }
    }

    return result;
  }, [chunks]);

  const wordIndexById = useMemo(() => {
    const result = new Map<string, number>();
    orderedWords.forEach((word, index) => result.set(word.id, index));
    return result;
  }, [orderedWords]);

  const wordToUnitId = useMemo(() => {
    const result = new Map<string, string>();
    for (const chunk of chunks) {
      for (const unit of chunk.units) {
        for (const wordId of unit.wordIds ?? []) {
          result.set(wordId, unit.unitId);
        }
      }
    }
    return result;
  }, [chunks]);

  const estimatedTotalSeconds = useMemo(() => {
    let total = 0;

    for (const chunk of chunks) {
      if (chunkShouldBeSkipped(chunk, skipContentSettings)) {
        continue;
      }
      const cacheKey = selectedVoiceId
        ? buildAudioCacheKey(selectedVoiceId, chunk.id, skipContentSettings)
        : "";
      total +=
        (cacheKey ? chunkAudio[cacheKey]?.duration : undefined) ??
        estimatedPlayableDuration(chunk, skipContentSettings);
    }

    return total;
  }, [chunks, chunkAudio, selectedVoiceId, skipContentSettings]);

  const currentGlobalSeconds = useMemo(() => {
    let elapsed = 0;

    for (let index = 0; index < activeChunkIndex; index += 1) {
      const chunk = chunks[index];
      if (chunkShouldBeSkipped(chunk, skipContentSettings)) {
        continue;
      }
      const cacheKey = selectedVoiceId
        ? buildAudioCacheKey(selectedVoiceId, chunk.id, skipContentSettings)
        : "";
      elapsed +=
        (cacheKey ? chunkAudio[cacheKey]?.duration : undefined) ??
        estimatedPlayableDuration(chunk, skipContentSettings);
    }

    elapsed += currentChunkLocalSeconds;

    return elapsed;
  }, [chunks, chunkAudio, activeChunkIndex, currentChunkLocalSeconds, selectedVoiceId, skipContentSettings]);

  useEffect(() => {
    activeUnitRef.current = activeUnit;
  }, [activeUnit]);

  useEffect(() => {
    const firstWordTiming = activeChunkAudio?.wordTimings?.[0] ?? null;
    activeWordIdRef.current = firstWordTiming?.wordId ?? "";
    setActiveWordTiming(firstWordTiming);
  }, [activeChunkAudio]);

  useEffect(() => {
    documentDataRef.current = documentData;
    pageVisibilityRef.current = {};

    if (documentData) {
      const persisted = readStoredReaderState(documentData.documentId);
      const pageNumber = Math.max(
        1,
        Math.min(
          documentData.pages.length || 1,
          persisted?.pageNumber ?? 1,
        ),
      );

      viewportPageNumberRef.current = pageNumber;
      setViewportPageNumber(pageNumber);
      setVisiblePageNumbers([pageNumber]);
    } else {
      viewportPageNumberRef.current = 1;
      setViewportPageNumber(1);
      setVisiblePageNumbers([1]);
    }
  }, [documentData]);

  useEffect(() => {
    if (openingDocumentId) {
      return;
    }

    const viewer = viewerRef.current;

    if (
      !viewer ||
      pages.length === 0 ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    pageVisibilityRef.current = {};

    const updateVisiblePages = () => {
      const nextVisiblePages = Object.entries(pageVisibilityRef.current)
        .filter(([, isVisible]) => isVisible)
        .map(([pageNumber]) => Number(pageNumber))
        .filter(Number.isFinite)
        .sort((left, right) => left - right);

      setVisiblePageNumbers((current) => {
        if (
          current.length === nextVisiblePages.length &&
          current.every(
            (pageNumber, index) =>
              pageNumber === nextVisiblePages[index],
          )
        ) {
          return current;
        }

        return nextVisiblePages;
      });

      if (nextVisiblePages.length === 0) {
        return;
      }

      const viewerRect = viewer.getBoundingClientRect();
      let bestPageNumber = nextVisiblePages[0];
      let bestOverlap = -1;

      for (const pageNumber of nextVisiblePages) {
        const pageElement = pageRefs.current[pageNumber];

        if (!pageElement) {
          continue;
        }

        const pageRect = pageElement.getBoundingClientRect();
        const overlap = Math.max(
          0,
          Math.min(pageRect.bottom, viewerRect.bottom) -
            Math.max(pageRect.top, viewerRect.top),
        );

        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestPageNumber = pageNumber;
        }
      }

      if (bestPageNumber !== viewportPageNumberRef.current) {
        viewportPageNumberRef.current = bestPageNumber;
        setViewportPageNumber(bestPageNumber);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNumber = Number(
            (entry.target as HTMLElement).dataset.pageNumber,
          );

          if (!Number.isFinite(pageNumber)) {
            continue;
          }

          pageVisibilityRef.current[pageNumber] =
            entry.isIntersecting &&
            entry.intersectionRect.height > 0 &&
            entry.intersectionRect.width > 0;
        }

        updateVisiblePages();
      },
      {
        root: viewer,
        rootMargin: "0px",
        threshold: [0, 0.001, 0.05, 0.25, 0.5, 0.75, 1],
      },
    );

    for (
      const element of Object.values(pageRefs.current) as Array<
        HTMLElement | null
      >
    ) {
      if (element) {
        observer.observe(element);
      }
    }

    return () => {
      observer.disconnect();
      pageVisibilityRef.current = {};
    };
  }, [
    pages.length,
    zoom,
    documentData?.documentId,
    openingDocumentId,
  ]);

  useEffect(() => {
    selectedVoiceIdRef.current = selectedVoiceId;
  }, [selectedVoiceId]);

  useEffect(() => {
    activeChunkIndexRef.current = activeChunkIndex;
  }, [activeChunkIndex]);

  useEffect(() => {
    selectedUnitIdRef.current = selectedUnitId;
  }, [selectedUnitId]);

  useEffect(() => {
    chunkAudioRef.current = chunkAudio;
  }, [chunkAudio]);

  useEffect(() => {
    autoScrollEnabledRef.current = autoScrollEnabled;
  }, [autoScrollEnabled]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    skipContentSettingsRef.current = skipContentSettings;
  }, [skipContentSettings]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updatePreference = () => setSystemPrefersDark(media.matches);

    updatePreference();
    media.addEventListener?.("change", updatePreference);

    return () => media.removeEventListener?.("change", updatePreference);
  }, []);

  useEffect(() => {
    const settings: StoredUiSettings = {
      themePreferenceVersion: THEME_PREFERENCE_VERSION,
      themeMode,
      cursorColor,
      sentenceHighlightEnabled,
      clickToReadEnabled,
      showStatusInformation,
      skipContent: skipContentSettings,
    };

    try {
      window.localStorage.setItem(STORAGE_UI_SETTINGS, JSON.stringify(settings));
    } catch {
      // Ignore unavailable storage contexts.
    }
  }, [
    themeMode,
    cursorColor,
    sentenceHighlightEnabled,
    clickToReadEnabled,
    showStatusInformation,
    skipContentSettings,
  ]);

  useEffect(() => {
    const documentId = documentData?.documentId;
    if (!documentId) {
      setBookmarks([]);
      return;
    }

    try {
      const raw = window.localStorage.getItem(`${STORAGE_BOOKMARK_PREFIX}${documentId}`);
      const parsed = raw ? (JSON.parse(raw) as Bookmark[]) : [];
      setBookmarks(Array.isArray(parsed) ? parsed : []);
    } catch {
      setBookmarks([]);
    }
  }, [documentData?.documentId]);

  useEffect(() => {
    const documentId = documentData?.documentId;
    clearTextSelection();

    if (!documentId) {
      setTextHighlights([]);
      return;
    }

    try {
      const raw = window.localStorage.getItem(`${STORAGE_HIGHLIGHT_PREFIX}${documentId}`);
      const parsed = raw ? (JSON.parse(raw) as TextHighlight[]) : [];
      setTextHighlights(Array.isArray(parsed) ? parsed : []);
    } catch {
      setTextHighlights([]);
    }
  }, [documentData?.documentId]);

  useEffect(() => {
    if (!selectionDraft || !selectionMenuPosition) {
      return;
    }

    function handleOutsidePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.closest(".text-selection-toolbar") || target.closest(".page-interaction-layer")) {
        return;
      }

      clearTextSelection();
    }

    window.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [selectionDraft, selectionMenuPosition]);

  useEffect(() => {
    if (openingDocumentId) {
      return;
    }

    const viewer = viewerRef.current;

    if (!viewer) {
      return;
    }

    function handlePinchZoom(event: WheelEvent) {
      if (!event.ctrlKey) {
        return;
      }

      event.preventDefault();

      const currentViewer = viewerRef.current;
      if (!currentViewer || !documentData || pages.length === 0) {
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

      const rect = currentViewer.getBoundingClientRect();
      const pointerX = event.clientX - rect.left + currentViewer.scrollLeft;
      const pointerY = event.clientY - rect.top + currentViewer.scrollTop;
      const ratio = nextZoom / currentZoom;

      zoomRef.current = nextZoom;
      setZoom(nextZoom);
      schedulePersistCurrentReaderState();

      window.requestAnimationFrame(() => {
        currentViewer.scrollLeft = pointerX * ratio - (event.clientX - rect.left);
        currentViewer.scrollTop = pointerY * ratio - (event.clientY - rect.top);
      });
    }

    viewer.addEventListener("wheel", handlePinchZoom, { passive: false });

    return () => {
      viewer.removeEventListener("wheel", handlePinchZoom);
    };
  }, [documentData?.documentId, pages.length, openingDocumentId]);

  useEffect(() => {
    const storedPdfUrl = documentData?.storedPdfUrl;

    if (!storedPdfUrl) {
      setPdfDocument(null);
      setPdfDocumentId("");
      return;
    }

    let disposed = false;
    const loadingTask = getDocument({
      url: `${API_BASE_URL}${storedPdfUrl}`,
      disableAutoFetch: false,
      disableStream: false,
      verbosity: 0,
    });

    setPdfDocument(null);
    setPdfDocumentId("");

    void loadingTask.promise
      .then((pdf) => {
        if (disposed) {
          return;
        }

        setPdfDocument(pdf);
        setPdfDocumentId(documentData?.documentId ?? "");
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        setStatus(`PDF-Anzeige konnte nicht geladen werden: ${message}`);
      });

    return () => {
      disposed = true;
      setPdfDocument(null);
      setPdfDocumentId("");
      void loadingTask.destroy();
    };
  }, [documentData?.storedPdfUrl]);

  useEffect(() => {
    if (openingDocumentId) {
      return;
    }

    const pending = pendingScrollRestoreRef.current;
    const currentDocumentId = documentData?.documentId;

    if (!pdfDocument || !pending || !currentDocumentId || pending.documentId !== currentDocumentId) {
      return;
    }

    let cancelled = false;
    let attempts = 0;

    const restorePosition = () => {
      if (cancelled) {
        return;
      }

      const viewer = viewerRef.current;
      const pageElement = pageRefs.current[pending.pageNumber];

      if ((!viewer || !pageElement) && attempts < 20) {
        attempts += 1;
        window.requestAnimationFrame(restorePosition);
        return;
      }

      if (!viewer || !pageElement) {
        pendingScrollRestoreRef.current = null;
        return;
      }

      const viewerRect = viewer.getBoundingClientRect();
      const pageRect = pageElement.getBoundingClientRect();
      const targetOffset = pending.pageOffsetRatio * pageRect.height;
      viewer.scrollTop += pageRect.top - viewerRect.top + targetOffset;
      pendingScrollRestoreRef.current = null;
      programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
    };

    window.requestAnimationFrame(restorePosition);

    return () => {
      cancelled = true;
    };
  }, [pdfDocument, documentData?.documentId, openingDocumentId]);

  useEffect(() => {
    if (
      !openingDocumentId ||
      documentData?.documentId !== openingDocumentId ||
      pdfDocumentId !== openingDocumentId
    ) {
      return;
    }

    const elapsed = performance.now() - openingDocumentStartedAtRef.current;
    const remaining = Math.max(0, DOCUMENT_SWITCH_SKELETON_MIN_MS - elapsed);

    const timeoutId = window.setTimeout(() => {
      setOpeningDocumentId((current) => current === documentData.documentId ? "" : current);
      setOpeningDocumentFilename("");
    }, remaining);

    return () => window.clearTimeout(timeoutId);
  }, [openingDocumentId, documentData?.documentId, pdfDocumentId]);

  useEffect(() => {
    if (!openingDocumentId || documentData?.documentId !== openingDocumentId) {
      return;
    }

    const fallbackId = window.setTimeout(() => {
      setOpeningDocumentId((current) => current === documentData.documentId ? "" : current);
      setOpeningDocumentFilename("");
    }, 6000);

    return () => window.clearTimeout(fallbackId);
  }, [openingDocumentId, documentData?.documentId]);

  useEffect(() => {
    let disposed = false;

    async function initializeApp() {
      await loadVoices();
      const availableDocuments = await loadDocuments();

      if (disposed) {
        return;
      }

      const documentFromUrl = new URL(window.location.href).searchParams.get("document");
      const lastDocumentId = window.localStorage.getItem(STORAGE_LAST_DOCUMENT);
      const preferredDocumentId =
        documentFromUrl && availableDocuments.some((document) => document.documentId === documentFromUrl)
          ? documentFromUrl
          : lastDocumentId;

      if (preferredDocumentId && availableDocuments.some((document) => document.documentId === preferredDocumentId)) {
        await loadDocument(preferredDocumentId);
      }
    }

    void initializeApp();

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => {
      persistCurrentReaderState();

      const sessionId = generationSessionRef.current;
      if (sessionId) {
        void fetch(`${API_BASE_URL}/api/tts/sessions/${encodeURIComponent(sessionId)}/cancel`, {
          method: "POST",
          keepalive: true,
        }).catch(() => undefined);
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      persistCurrentReaderState();

      if (readerPersistTimerRef.current !== null) {
        window.clearTimeout(readerPersistTimerRef.current);
        readerPersistTimerRef.current = null;
      }

      clearAudioFadeSchedule();

      const audioContext = audioContextRef.current;
      audioContextRef.current = null;
      audioSourceNodeRef.current = null;
      audioGainNodeRef.current = null;

      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close().catch(() => undefined);
      }

      for (const controller of requestControllersRef.current) {
        controller.abort();
      }
      requestControllersRef.current.clear();
      cancelRemoteGenerationSession(generationSessionRef.current);
    };
  }, []);

  useEffect(() => {
    playbackRateRef.current = playbackRate;

    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.defaultPlaybackRate = playbackRate;
    audio.playbackRate = playbackRate;

    if (!audio.paused && !audio.ended) {
      scheduleAudioChunkFadeOut(audio);
    }
  }, [playbackRate]);

  useEffect(() => {
    volumeRef.current = volume;

    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const context = audioContextRef.current;
    const gainNode = audioGainNodeRef.current;

    if (context && gainNode) {
      const now = context.currentTime;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(clampAudioVolume(volume), now);

      if (!audio.paused && !audio.ended) {
        scheduleAudioChunkFadeOut(audio);
      }

      return;
    }

    audio.volume = clampAudioVolume(volume);
  }, [volume]);

  useEffect(() => {
    if (!activeUnit || !autoScrollEnabled || pendingScrollRestoreRef.current) {
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
      schedulePersistCurrentReaderState();

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
          autoScrollEnabledRef.current = false;
          setAutoScrollEnabled(false);
          setStatus("Automatisch folgen deaktiviert: Lesestelle wurde manuell verlassen.");
          schedulePersistCurrentReaderState(0);
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b" && documentDataRef.current) {
        event.preventDefault();
        addCurrentBookmark();
        return;
      }

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
  }, [documentData, chunks.length, isPlaying, activeChunkIndex, selectedVoiceId, playbackRate]);

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    const activeAudio = audio;

    function syncPlaybackPosition() {
      const currentAudio = audioRef.current;

      if (!currentAudio) {
        return;
      }

      const localTime = currentAudio.currentTime;
      currentChunkLocalSecondsRef.current = localTime;

      const now = performance.now();
      if (now - lastPlaybackUiUpdateAtRef.current >= 250 || currentAudio.paused || currentAudio.ended) {
        lastPlaybackUiUpdateAtRef.current = now;
        setCurrentChunkLocalSeconds(localTime);
      }

      const wordTimings = activeChunkAudio?.wordTimings ?? [];
      let nextWordTiming: WordTiming | null = null;

      if (wordTimings.length > 0) {
        nextWordTiming =
          wordTimings.find((timing) => localTime >= timing.start && localTime < timing.end) ??
          (localTime >= wordTimings[wordTimings.length - 1].start
            ? wordTimings[wordTimings.length - 1]
            : wordTimings[0]);
      }

      const nextWordId = nextWordTiming?.wordId ?? "";
      if (nextWordId !== activeWordIdRef.current) {
        activeWordIdRef.current = nextWordId;
        setActiveWordTiming(nextWordTiming);
      }

      if (Date.now() - lastReaderPersistAtRef.current >= 1000) {
        persistCurrentReaderState();
      }

    }

    function stopAnimationLoop() {
      if (playbackAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(playbackAnimationFrameRef.current);
        playbackAnimationFrameRef.current = null;
      }
    }

    function startAnimationLoop() {
      stopAnimationLoop();

      const tick = () => {
        syncPlaybackPosition();

        if (audioRef.current && !audioRef.current.paused && !audioRef.current.ended) {
          playbackAnimationFrameRef.current = window.requestAnimationFrame(tick);
        } else {
          playbackAnimationFrameRef.current = null;
        }
      };

      playbackAnimationFrameRef.current = window.requestAnimationFrame(tick);
    }

    function handleTimeUpdate() {
      syncPlaybackPosition();
    }

    function handleEnded() {
      clearAudioFadeSchedule();
      setAudioGainImmediately(0);
      stopAnimationLoop();
      syncPlaybackPosition();

      const nextIndex = findPlayableChunkIndex(
        chunks,
        activeChunkIndex + 1,
        1,
        skipContentSettingsRef.current,
      );

      if (nextIndex < 0) {
        setIsPlaying(false);
        persistCurrentReaderState();
        return;
      }

      void playChunk(nextIndex, 0);
    }

    function handlePlay() {
      setIsPlaying(true);
      startAnimationLoop();
      applyAudioChunkFadeIn(activeAudio);
    }

    function handlePause() {
      clearAudioFadeSchedule();
      syncPlaybackPosition();
      stopAnimationLoop();
      setIsPlaying(false);
    }

    activeAudio.addEventListener("timeupdate", handleTimeUpdate);
    activeAudio.addEventListener("ended", handleEnded);
    activeAudio.addEventListener("play", handlePlay);
    activeAudio.addEventListener("pause", handlePause);

    if (!audio.paused && !audio.ended) {
      startAnimationLoop();
    }

    return () => {
      stopAnimationLoop();
      activeAudio.removeEventListener("timeupdate", handleTimeUpdate);
      activeAudio.removeEventListener("ended", handleEnded);
      activeAudio.removeEventListener("play", handlePlay);
      activeAudio.removeEventListener("pause", handlePause);
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

  function formatPlaybackError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const normalized = raw.toLowerCase();

    if (normalized.includes("speichermangel") || normalized.includes("exit-code 137")) {
      return "CosyVoice wurde wegen zu wenig Docker-Arbeitsspeicher beendet. Die Modelldaten bleiben gespeichert.";
    }

    if (normalized.includes("remote end closed connection")) {
      return "Die Verbindung zu CosyVoice wurde während der Audioerzeugung unterbrochen.";
    }

    if (normalized.includes("nach 2 versuchen")) {
      return "CosyVoice konnte das Audio nach 2 Versuchen nicht erzeugen.";
    }

    if (normalized.includes("noch nicht bereit") || normalized.includes("konnte nicht gestartet werden")) {
      return "Der CosyVoice-Server ist aktuell nicht bereit.";
    }

    if (normalized.includes("keine gültige wav")) {
      return "CosyVoice hat keine gültige Audiodatei erzeugt.";
    }

    return raw.length > 220 ? `${raw.slice(0, 217)}...` : raw;
  }

  function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }

  function currentPagePosition(): { pageNumber: number; pageOffsetRatio: number } | null {
    const viewer = viewerRef.current;
    if (!viewer) {
      return null;
    }

    const viewerRect = viewer.getBoundingClientRect();
    let bestPageNumber = 0;
    let bestOverlap = -1;
    let bestOffsetRatio = 0;

    for (const [pageNumberText, element] of Object.entries(pageRefs.current) as Array<[string, HTMLElement | null]>) {
      if (!element) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(rect.bottom, viewerRect.bottom) - Math.max(rect.top, viewerRect.top));

      if (overlap <= bestOverlap) {
        continue;
      }

      bestOverlap = overlap;
      bestPageNumber = Number(pageNumberText);
      bestOffsetRatio = rect.height > 0
        ? Math.max(0, Math.min(1, (viewerRect.top - rect.top) / rect.height))
        : 0;
    }

    if (bestPageNumber <= 0) {
      return null;
    }

    return {
      pageNumber: bestPageNumber,
      pageOffsetRatio: bestOffsetRatio,
    };
  }

  function persistCurrentReaderState() {
    const currentDocument = documentDataRef.current;
    if (!currentDocument) {
      return;
    }

    const pagePosition = currentPagePosition();
    const fallbackPageNumber = activeUnitRef.current?.pageNumber ?? 1;

    const state: PersistedReaderState = {
      pageNumber: pagePosition?.pageNumber ?? fallbackPageNumber,
      pageOffsetRatio: pagePosition?.pageOffsetRatio ?? 0,
      activeChunkIndex: activeChunkIndexRef.current,
      currentChunkLocalSeconds: currentChunkLocalSecondsRef.current,
      selectedUnitId: selectedUnitIdRef.current,
      zoom: zoomRef.current,
      autoScrollEnabled: autoScrollEnabledRef.current,
      updatedAt: Date.now(),
    };

    try {
      window.localStorage.setItem(
        `${STORAGE_READER_PREFIX}${currentDocument.documentId}`,
        JSON.stringify(state),
      );
      window.localStorage.setItem(STORAGE_LAST_DOCUMENT, currentDocument.documentId);
      lastReaderPersistAtRef.current = Date.now();
    } catch {
      // localStorage can be unavailable in hardened/private browser contexts.
    }
  }

  function schedulePersistCurrentReaderState(delay = 180) {
    if (readerPersistTimerRef.current !== null) {
      window.clearTimeout(readerPersistTimerRef.current);
    }

    readerPersistTimerRef.current = window.setTimeout(() => {
      readerPersistTimerRef.current = null;
      persistCurrentReaderState();
    }, delay);
  }

  function cancelRemoteGenerationSession(sessionId: string) {
    if (!sessionId) {
      return;
    }

    void fetch(`${API_BASE_URL}/api/tts/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
      keepalive: true,
    }).catch(() => undefined);
  }

  function rotateGenerationSession(): string {
    const previousSessionId = generationSessionRef.current;

    for (const controller of requestControllersRef.current) {
      controller.abort();
    }
    requestControllersRef.current.clear();
    preloadInFlightRef.current.clear();

    const nextSessionId = createGenerationSessionId();
    generationSessionRef.current = nextSessionId;
    cancelRemoteGenerationSession(previousSessionId);
    return nextSessionId;
  }

  async function loadVoices() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/voices`);

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = (await response.json()) as VoicesResponse;
      setVoices(data.voices);
      setVoiceVariants(data.variants ?? []);

      const storedVoiceId = window.localStorage.getItem(STORAGE_SELECTED_VOICE) ?? "";
      const storedVoice = data.voices.find((voice) => voice.id === storedVoiceId && voice.available);
      const defaultVoice = data.voices.find((voice) => voice.id === data.defaultVoiceId && voice.available);
      const firstAvailableVoice = data.voices.find((voice) => voice.available);
      const nextVoiceId = storedVoice?.id ?? defaultVoice?.id ?? firstAvailableVoice?.id ?? "";

      selectedVoiceIdRef.current = nextVoiceId;
      setSelectedVoiceId(nextVoiceId);

      if (nextVoiceId) {
        window.localStorage.setItem(STORAGE_SELECTED_VOICE, nextVoiceId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Fehler beim Laden der Stimmen: ${message}`);
    }
  }

  async function refreshVoiceCatalog(): Promise<PiperVoice[]> {
    const response = await fetch(`${API_BASE_URL}/api/voices`);

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const data = (await response.json()) as VoicesResponse;
    setVoices(data.voices);
    setVoiceVariants(data.variants ?? []);
    return data.voices;
  }

  async function refreshVoiceDownloadStatus(voiceId: string): Promise<PiperVoice> {
    const response = await fetch(
      `${API_BASE_URL}/api/voices/${encodeURIComponent(voiceId)}/download`,
      { cache: "no-store" },
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const updatedVoice = (await response.json()) as PiperVoice;

    setVoices((currentVoices) =>
      currentVoices.map((voice) =>
        voice.id === updatedVoice.id ? updatedVoice : voice,
      ),
    );

    return updatedVoice;
  }

  async function downloadVoice(voiceId: string): Promise<void> {
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/voices/${encodeURIComponent(voiceId)}/download`,
        { method: "POST" },
      );

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const startedVoice = (await response.json()) as PiperVoice;

      setVoices((currentVoices) =>
        currentVoices.map((voice) =>
          voice.id === startedVoice.id ? startedVoice : voice,
        ),
      );

      while (true) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));

        const voice = await refreshVoiceDownloadStatus(voiceId);

        if (voice.downloadState === "error") {
          throw new Error(voice.downloadError || "Download fehlgeschlagen.");
        }

        if (!["downloading", "paused"].includes(voice.downloadState)) {
          await refreshVoiceCatalog();
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Stimmen-Download fehlgeschlagen: ${message}`);
      throw error;
    }
  }

  async function updateVoiceDownloadAction(
    voiceId: string,
    action: "pause" | "resume" | "cancel",
  ): Promise<void> {
    const method = action === "cancel" ? "DELETE" : "POST";
    const suffix = action === "cancel" ? "" : `/${action}`;
    const response = await fetch(
      `${API_BASE_URL}/api/voices/${encodeURIComponent(voiceId)}/download${suffix}`,
      { method },
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const updatedVoice = (await response.json()) as PiperVoice;
    setVoices((currentVoices) =>
      currentVoices.map((voice) =>
        voice.id === updatedVoice.id ? updatedVoice : voice,
      ),
    );
  }

  async function pauseVoiceDownload(voiceId: string): Promise<void> {
    await updateVoiceDownloadAction(voiceId, "pause");
  }

  async function resumeVoiceDownload(voiceId: string): Promise<void> {
    await updateVoiceDownloadAction(voiceId, "resume");
  }

  async function cancelVoiceDownload(voiceId: string): Promise<void> {
    await updateVoiceDownloadAction(voiceId, "cancel");
  }

  async function loadDocuments(): Promise<DocumentSummary[]> {
    try {
      const response = await fetch(`${API_BASE_URL}/api/documents`);

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = (await response.json()) as { documents: DocumentSummary[] };
      const orderedDocuments = applyStoredSidebarDocumentOrder(data.documents);
      setDocuments(orderedDocuments);
      return orderedDocuments;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Fehler beim Laden gespeicherter PDFs: ${message}`);
      return [];
    }
  }

  function updateDocumentDragPreview(clientX: number, clientY: number) {
    if (clientX <= 0 || clientY <= 0) {
      return;
    }

    setDocumentDragPreviewPosition((current) => {
      if (
        current &&
        Math.abs(current.x - clientX) < 2 &&
        Math.abs(current.y - clientY) < 2
      ) {
        return current;
      }

      return {
        x: clientX,
        y: clientY,
      };
    });
  }

  function resetDocumentPointerDrag() {
    documentPointerDragRef.current = null;
    documentDropTargetRef.current = null;
    setDraggedDocumentId("");
    setDocumentDragPreviewPosition(null);
  }

  function updateDocumentPointerDropTarget(
    draggedId: string,
    clientX: number,
    clientY: number,
  ) {
    const hitElement = window.document.elementFromPoint(clientX, clientY);
    const targetElement = hitElement?.closest<HTMLElement>(
      ".document-list-item[data-document-id]",
    );

    if (targetElement) {
      const targetId = targetElement.dataset.documentId ?? "";

      if (!targetId || targetId === draggedId) {
        return;
      }

      const targetRect = targetElement.getBoundingClientRect();
      const position: "before" | "after" =
        clientY < targetRect.top + targetRect.height / 2
          ? "before"
          : "after";

      const currentTarget = documentDropTargetRef.current;

      if (
        currentTarget?.documentId === targetId &&
        currentTarget.position === position
      ) {
        return;
      }

      const nextTarget = {
        documentId: targetId,
        position,
      } as const;

      documentDropTargetRef.current = nextTarget;
      reorderSidebarDocument(draggedId, targetId, position);
      return;
    }

    const list = documentListRef.current;

    if (!list || documents.length === 0) {
      return;
    }

    const listRect = list.getBoundingClientRect();

    if (
      clientX < listRect.left ||
      clientX > listRect.right ||
      clientY < listRect.top - 16 ||
      clientY > listRect.bottom + 48
    ) {
      return;
    }

    const firstDocument = documents[0];
    const lastDocument = documents[documents.length - 1];

    const firstElement = firstDocument
      ? documentItemRefs.current[firstDocument.documentId]
      : null;
    const lastElement = lastDocument
      ? documentItemRefs.current[lastDocument.documentId]
      : null;

    if (
      firstDocument &&
      firstElement &&
      firstDocument.documentId !== draggedId &&
      clientY < firstElement.getBoundingClientRect().top
    ) {
      const nextTarget = {
        documentId: firstDocument.documentId,
        position: "before",
      } as const;

      const currentTarget = documentDropTargetRef.current;

      if (
        currentTarget?.documentId !== nextTarget.documentId ||
        currentTarget.position !== nextTarget.position
      ) {
        documentDropTargetRef.current = nextTarget;
          reorderSidebarDocument(
          draggedId,
          nextTarget.documentId,
          nextTarget.position,
        );
      }

      return;
    }

    if (
      lastDocument &&
      lastElement &&
      lastDocument.documentId !== draggedId &&
      clientY > lastElement.getBoundingClientRect().bottom
    ) {
      const nextTarget = {
        documentId: lastDocument.documentId,
        position: "after",
      } as const;

      const currentTarget = documentDropTargetRef.current;

      if (
        currentTarget?.documentId !== nextTarget.documentId ||
        currentTarget.position !== nextTarget.position
      ) {
        documentDropTargetRef.current = nextTarget;
          reorderSidebarDocument(
          draggedId,
          nextTarget.documentId,
          nextTarget.position,
        );
      }
    }
  }

  function reorderSidebarDocument(
    draggedId: string,
    targetId: string,
    position: "before" | "after",
  ) {
    if (!draggedId || !targetId || draggedId === targetId) {
      return;
    }

    const beforePositions = new Map<string, DOMRect>();

    for (const document of documents) {
      const element = documentItemRefs.current[document.documentId];
      if (element) {
        beforePositions.set(document.documentId, element.getBoundingClientRect());
      }
    }

    setDocuments((currentDocuments) => {
      const draggedIndex = currentDocuments.findIndex((document) => document.documentId === draggedId);
      const targetIndex = currentDocuments.findIndex((document) => document.documentId === targetId);

      if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
        return currentDocuments;
      }

      const nextDocuments = [...currentDocuments];
      const [draggedDocument] = nextDocuments.splice(draggedIndex, 1);

      const targetIndexAfterRemoval = nextDocuments.findIndex(
        (document) => document.documentId === targetId,
      );

      if (targetIndexAfterRemoval < 0) {
        return currentDocuments;
      }

      const insertionIndex =
        position === "after"
          ? targetIndexAfterRemoval + 1
          : targetIndexAfterRemoval;

      nextDocuments.splice(insertionIndex, 0, draggedDocument);
      persistSidebarDocumentOrder(nextDocuments);

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          for (const document of nextDocuments) {
            if (document.documentId === draggedId) {
              continue;
            }

            const element = documentItemRefs.current[document.documentId];
            const before = beforePositions.get(document.documentId);

            if (!element || !before) {
              continue;
            }

            const after = element.getBoundingClientRect();
            const deltaY = before.top - after.top;

            if (Math.abs(deltaY) < 1) {
              continue;
            }

            element.animate(
              [
                { transform: `translateY(${deltaY}px)` },
                { transform: "translateY(0)" },
              ],
              {
                duration: 180,
                easing: "cubic-bezier(0.22, 1, 0.36, 1)",
              },
            );
          }
        });
      });

      return nextDocuments;
    });
  }

  async function loadDocument(documentId: string) {
    if (!documentId) {
      return;
    }

    if (
      documentId === documentDataRef.current?.documentId &&
      !openingDocumentId
    ) {
      return;
    }

    const selectedDocument = documents.find((document) => document.documentId === documentId);

    persistCurrentReaderState();
    rotateGenerationSession();
    stopPlayback();
    setPlayerVisible(false);
    setActiveUnitId("");
    selectedUnitIdRef.current = "";
    setSelectedUnitId("");
    activeWordIdRef.current = "";
    setActiveWordTiming(null);
    clearTextSelection();
    closeMenus();
    pageRefs.current = {};

    documentLoadAbortRef.current?.abort();
    const controller = new AbortController();
    documentLoadAbortRef.current = controller;

    const requestId = documentLoadRequestRef.current + 1;
    documentLoadRequestRef.current = requestId;
    openingDocumentStartedAtRef.current = performance.now();

    setOpeningDocumentId(documentId);
    setOpeningDocumentFilename(selectedDocument?.filename ?? "Dokument");
    setIsUploading(true);
    setStatus(`Öffne ${selectedDocument?.filename ?? documentId} ...`);

    try {
      const response = await fetch(`${API_BASE_URL}/api/documents/${documentId}`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = (await response.json()) as DocumentData;

      if (
        controller.signal.aborted ||
        requestId !== documentLoadRequestRef.current
      ) {
        return;
      }

      const persisted = readStoredReaderState(data.documentId);
      const dataChunks = data.chunks ?? [];
      const restoredChunkIndex = persisted
        ? Math.max(0, Math.min(Math.max(0, dataChunks.length - 1), persisted.activeChunkIndex))
        : 0;
      const restoredUnit =
        (persisted?.selectedUnitId
          ? dataChunks.flatMap((chunk) => chunk.units).find((unit) => unit.unitId === persisted.selectedUnitId)
          : null) ??
        dataChunks[restoredChunkIndex]?.units[0] ??
        null;
      const restoredTime = persisted?.currentChunkLocalSeconds ?? 0;
      const restoredZoom = persisted?.zoom ?? 0.65;
      const restoredAutoScroll = persisted?.autoScrollEnabled ?? true;

      documentDataRef.current = data;
      setDocumentData(data);

      activeChunkIndexRef.current = restoredChunkIndex;
      setActiveChunkIndex(restoredChunkIndex);
      setActiveUnitId(restoredUnit?.unitId ?? "");
      selectedUnitIdRef.current = restoredUnit?.unitId ?? "";
      setSelectedUnitId(restoredUnit?.unitId ?? "");
      currentChunkLocalSecondsRef.current = restoredTime;
      setCurrentChunkLocalSeconds(restoredTime);
      zoomRef.current = restoredZoom;
      setZoom(restoredZoom);
      autoScrollEnabledRef.current = restoredAutoScroll;
      setAutoScrollEnabled(restoredAutoScroll);

      chunkAudioRef.current = {};
      setChunkAudio({});
      preloadInFlightRef.current.clear();
      lastAutoScrolledUnitIdRef.current = "";
      programmaticScrollUntilRef.current = 0;

      pendingScrollRestoreRef.current = persisted
        ? { ...persisted, documentId: data.documentId }
        : {
            documentId: data.documentId,
            pageNumber: restoredUnit?.pageNumber ?? 1,
            pageOffsetRatio: 0,
            activeChunkIndex: restoredChunkIndex,
            currentChunkLocalSeconds: restoredTime,
            selectedUnitId: restoredUnit?.unitId ?? "",
            zoom: restoredZoom,
            autoScrollEnabled: restoredAutoScroll,
            updatedAt: Date.now(),
          };

      window.localStorage.setItem(STORAGE_LAST_DOCUMENT, data.documentId);
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("document", data.documentId);
      window.history.replaceState({}, "", nextUrl);
      setStatus(`Geladen: ${data.filename} | Seiten: ${data.pageCount} | Chunks: ${data.chunks?.length ?? 0}`);
    } catch (error) {
      if (controller.signal.aborted || requestId !== documentLoadRequestRef.current) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      setOpeningDocumentId("");
      setOpeningDocumentFilename("");
      setStatus(`Fehler: ${message}`);
    } finally {
      if (requestId === documentLoadRequestRef.current) {
        setIsUploading(false);
      }

      if (documentLoadAbortRef.current === controller) {
        documentLoadAbortRef.current = null;
      }
    }
  }

  async function uploadPdf(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setStatus("Fehler: Bitte eine PDF-Datei auswählen.");
      return;
    }

    persistCurrentReaderState();
    rotateGenerationSession();
    stopPlayback();
    setPlayerVisible(false);
    setActiveUnitId("");
    selectedUnitIdRef.current = "";
    setSelectedUnitId("");
    activeWordIdRef.current = "";
    setActiveWordTiming(null);

    const formData = new FormData();
    formData.append("file", file);

    setIsUploading(true);
    setStatus(`Lade und analysiere ${file.name} ...`);
    documentDataRef.current = null;
    setDocumentData(null);
    activeChunkIndexRef.current = 0;
    setActiveChunkIndex(0);
    setActiveUnitId("");
    selectedUnitIdRef.current = "";
    setSelectedUnitId("");
    currentChunkLocalSecondsRef.current = 0;
    setCurrentChunkLocalSeconds(0);
    chunkAudioRef.current = {};
    setChunkAudio({});
    preloadInFlightRef.current.clear();
    lastAutoScrolledUnitIdRef.current = "";
    programmaticScrollUntilRef.current = 0;

    try {
      const response = await fetch(`${API_BASE_URL}/api/documents/upload`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = (await response.json()) as DocumentData;

      documentDataRef.current = data;
      setDocumentData(data);
      pendingScrollRestoreRef.current = {
        documentId: data.documentId,
        pageNumber: 1,
        pageOffsetRatio: 0,
        activeChunkIndex: 0,
        currentChunkLocalSeconds: 0,
        selectedUnitId: data.chunks?.[0]?.units[0]?.unitId ?? "",
        zoom: zoomRef.current,
        autoScrollEnabled: true,
        updatedAt: Date.now(),
      };
      window.localStorage.setItem(STORAGE_LAST_DOCUMENT, data.documentId);
      setStatus(`Geladen: ${data.filename} | Seiten: ${data.pageCount} | Chunks: ${data.chunks?.length ?? 0}`);
      await loadDocuments();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Fehler: ${message}`);
    } finally {
      setIsUploading(false);
    }
  }

  async function requestChunkAudio(
    chunk: TtsChunk,
    options?: { voiceId?: string; sessionId?: string },
  ): Promise<ChunkAudioResponse> {
    const currentDocument = documentDataRef.current;
    if (!currentDocument) {
      throw new Error("Kein Dokument geladen.");
    }

    const voiceId = options?.voiceId ?? selectedVoiceIdRef.current;
    const sessionId = options?.sessionId ?? generationSessionRef.current;

    if (!voiceId) {
      throw new Error("Keine Stimme ausgewählt.");
    }

    const skipSettings = skipContentSettingsRef.current;
    const cacheKey = buildAudioCacheKey(voiceId, chunk.id, skipSettings);
    const cached = chunkAudioRef.current[cacheKey];
    if (cached && cached.requestedVoiceId === voiceId) {
      return cached;
    }

    const controller = new AbortController();
    requestControllersRef.current.add(controller);

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/documents/${currentDocument.documentId}/tts/chunks/${chunk.id}?voiceId=${encodeURIComponent(
          voiceId,
        )}&sessionId=${encodeURIComponent(sessionId)}&skipCategories=${encodeURIComponent(
          enabledSkipCategories(skipSettings).join(","),
        )}`,
        {
          method: "POST",
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        if (response.status === 409 && sessionId !== generationSessionRef.current) {
          throw new DOMException("Veraltete TTS-Anfrage abgebrochen.", "AbortError");
        }

        const rawError = await response.text();
        let errorCode = "";
        let errorMessage = rawError;

        try {
          const parsed = JSON.parse(rawError) as {
            detail?: string | { code?: string; message?: string; chunkId?: string };
          };

          if (typeof parsed.detail === "string") {
            errorMessage = parsed.detail;
          } else if (parsed.detail) {
            errorCode = parsed.detail.code ?? "";
            errorMessage = parsed.detail.message ?? rawError;
          }
        } catch {
          errorMessage = rawError;
        }

        if (response.status === 409 && errorCode === "SKIPPED_BY_RULES") {
          throw new SkippedTtsChunkError(chunk.id, errorMessage);
        }

        throw new Error(errorMessage);
      }

      const data = (await response.json()) as ChunkAudioResponse;

      if (
        sessionId !== generationSessionRef.current ||
        voiceId !== selectedVoiceIdRef.current ||
        currentDocument.documentId !== documentDataRef.current?.documentId
      ) {
        throw new DOMException("Veraltete TTS-Antwort verworfen.", "AbortError");
      }

      if (data.requestedVoiceId && data.requestedVoiceId !== voiceId) {
        throw new DOMException("TTS-Antwort gehört zu einer anderen Stimme.", "AbortError");
      }

      chunkAudioRef.current = {
        ...chunkAudioRef.current,
        [cacheKey]: data,
      };

      setChunkAudio((previous) => ({
        ...previous,
        [cacheKey]: data,
      }));

      return data;
    } finally {
      requestControllersRef.current.delete(controller);
    }
  }

  async function preloadNextChunks(
    fromIndex: number,
    sessionId = generationSessionRef.current,
    voiceId = selectedVoiceIdRef.current,
  ) {
    const currentDocument = documentDataRef.current;
    const currentChunks = currentDocument?.chunks ?? [];

    if (!currentDocument || currentChunks.length === 0 || !voiceId) {
      return;
    }

    const nextChunks: TtsChunk[] = [];
    for (let index = fromIndex + 1; index < currentChunks.length && nextChunks.length < PRELOAD_CHUNK_COUNT; index += 1) {
      const candidate = currentChunks[index];
      if (!chunkShouldBeSkipped(candidate, skipContentSettingsRef.current)) {
        nextChunks.push(candidate);
      }
    }

    for (const chunk of nextChunks) {
      if (sessionId !== generationSessionRef.current || voiceId !== selectedVoiceIdRef.current) {
        return;
      }

      const cacheKey = buildAudioCacheKey(voiceId, chunk.id, skipContentSettingsRef.current);
      const inFlightKey = `${sessionId}::${cacheKey}`;

      if (chunkAudioRef.current[cacheKey] || preloadInFlightRef.current.has(inFlightKey)) {
        continue;
      }

      preloadInFlightRef.current.add(inFlightKey);

      try {
        await requestChunkAudio(chunk, { voiceId, sessionId });
      } catch (error) {
        if (!isAbortError(error) && !(error instanceof SkippedTtsChunkError)) {
          console.warn(`Audio für ${chunk.id} konnte nicht vorgeladen werden:`, error);
        }
      } finally {
        preloadInFlightRef.current.delete(inFlightKey);
      }
    }
  }

  async function waitForAudioMetadata(audio: HTMLAudioElement): Promise<void> {
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const handleLoadedMetadata = () => {
        cleanup();
        resolve();
      };

      const handleError = () => {
        cleanup();
        reject(new Error("Audio-Metadaten konnten nicht geladen werden."));
      };

      const cleanup = () => {
        audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
        audio.removeEventListener("error", handleError);
      };

      audio.addEventListener("loadedmetadata", handleLoadedMetadata, { once: true });
      audio.addEventListener("error", handleError, { once: true });
    });
  }

  function ensureAudioGraph(audio: HTMLAudioElement): AudioContext | null {
    try {
      let context = audioContextRef.current;
      let gainNode = audioGainNodeRef.current;

      if (!context) {
        context = new AudioContext({ latencyHint: "interactive" });

        const sourceNode = context.createMediaElementSource(audio);
        gainNode = context.createGain();

        sourceNode.connect(gainNode);
        gainNode.connect(context.destination);

        audioContextRef.current = context;
        audioSourceNodeRef.current = sourceNode;
        audioGainNodeRef.current = gainNode;

        // Volume is controlled exclusively by the GainNode once the media
        // element is attached to Web Audio.
        audio.volume = 1;
        gainNode.gain.value = clampAudioVolume(volumeRef.current);
      }

      if (context.state === "suspended") {
        void context.resume().catch(() => undefined);
      }

      return context;
    } catch (error) {
      console.warn("Web-Audio-Ausgabe konnte nicht initialisiert werden:", error);
      return null;
    }
  }

  function clampAudioVolume(value: number) {
    return Math.max(0, Math.min(1, value));
  }

  function cancelScheduledAudioGain() {
    const context = audioContextRef.current;
    const gainNode = audioGainNodeRef.current;

    if (!context || !gainNode) {
      return;
    }

    const now = context.currentTime;

    try {
      gainNode.gain.cancelAndHoldAtTime(now);
    } catch {
      const currentValue = gainNode.gain.value;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(currentValue, now);
    }
  }

  function setAudioGainImmediately(value: number) {
    const context = audioContextRef.current;
    const gainNode = audioGainNodeRef.current;

    if (!context || !gainNode) {
      const audio = audioRef.current;
      if (audio) {
        audio.volume = clampAudioVolume(value);
      }
      return;
    }

    const now = context.currentTime;
    const nextValue = clampAudioVolume(value);

    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(nextValue, now);
  }

  function clearAudioFadeSchedule() {
    cancelScheduledAudioGain();
  }

  function scheduleAudioChunkFadeOut(audio: HTMLAudioElement) {
    const context = ensureAudioGraph(audio);
    const gainNode = audioGainNodeRef.current;

    if (
      !context ||
      !gainNode ||
      audio.paused ||
      audio.ended ||
      !Number.isFinite(audio.duration) ||
      audio.duration <= 0
    ) {
      return;
    }

    const rate = Math.max(0.05, audio.playbackRate || playbackRateRef.current || 1);
    const remainingMediaSeconds = Math.max(0, audio.duration - audio.currentTime);
    const remainingWallSeconds = remainingMediaSeconds / rate;
    const fadeSeconds = Math.min(
      AUDIO_CHUNK_FADE_OUT_MS / 1000,
      Math.max(0.004, remainingWallSeconds),
    );
    const now = context.currentTime;
    const fadeStart = now + Math.max(0, remainingWallSeconds - fadeSeconds);
    const fadeEnd = now + remainingWallSeconds;
    const targetVolume = clampAudioVolume(volumeRef.current);

    // Do not disturb an already scheduled fade-in at the current time.
    gainNode.gain.cancelScheduledValues(fadeStart);
    gainNode.gain.setValueAtTime(targetVolume, fadeStart);
    gainNode.gain.linearRampToValueAtTime(0, fadeEnd);
  }

  function applyAudioChunkFadeIn(audio: HTMLAudioElement) {
    const context = ensureAudioGraph(audio);
    const gainNode = audioGainNodeRef.current;
    const targetVolume = clampAudioVolume(volumeRef.current);

    if (!context || !gainNode) {
      audio.volume = targetVolume;
      return;
    }

    const now = context.currentTime;
    const fadeEnd = now + AUDIO_CHUNK_FADE_IN_MS / 1000;

    audio.volume = 1;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(targetVolume, fadeEnd);

    scheduleAudioChunkFadeOut(audio);
  }

  async function playChunk(
    index: number,
    startLocalSeconds: number,
    preparedData?: ChunkAudioResponse,
  ) {
    const currentDocument = documentDataRef.current;
    const currentChunks = currentDocument?.chunks ?? [];
    const voiceId = selectedVoiceIdRef.current;
    const sessionId = generationSessionRef.current;

    if (!currentDocument || currentChunks.length === 0) {
      return;
    }

    if (!voiceId) {
      setStatus("Keine Stimme gefunden.");
      return;
    }

    const attemptId = playbackAttemptRef.current + 1;
    playbackAttemptRef.current = attemptId;

    const boundedIndex = Math.max(0, Math.min(currentChunks.length - 1, index));
    const safeIndex = findPlayableChunkIndex(
      currentChunks,
      boundedIndex,
      1,
      skipContentSettingsRef.current,
    );

    if (safeIndex < 0) {
      setIsPlaying(false);
      setStatus("Keine weiteren vorlesbaren Inhalte gefunden.");
      return;
    }

    const chunk = currentChunks[safeIndex];
    const firstUnit = chunk.units[0] ?? null;
    const cacheKey = buildAudioCacheKey(voiceId, chunk.id, skipContentSettingsRef.current);

    const currentAudio = audioRef.current;
    if (currentAudio) {
      ensureAudioGraph(currentAudio);
    }

    clearAudioFadeSchedule();
    setAudioGainImmediately(0);

    if (currentAudio && !currentAudio.paused) {
      currentAudio.pause();
    }

    setIsPlaying(false);
    setPlaybackError(null);
    setIsLoadingAudio(true);
    activeChunkIndexRef.current = safeIndex;
    setActiveChunkIndex(safeIndex);
    setActiveUnitId(firstUnit?.unitId ?? "");
    selectedUnitIdRef.current = firstUnit?.unitId ?? "";
    setSelectedUnitId(firstUnit?.unitId ?? "");
    currentChunkLocalSecondsRef.current = Math.max(0, startLocalSeconds);
    setCurrentChunkLocalSeconds(Math.max(0, startLocalSeconds));
    setStatus(`Lade Audio für Satz ${safeIndex + 1} / ${currentChunks.length} ...`);
    schedulePersistCurrentReaderState();

    try {
      const preparedMatchesVoice =
        preparedData &&
        (!preparedData.requestedVoiceId || preparedData.requestedVoiceId === voiceId);
      const data =
        (preparedMatchesVoice ? preparedData : undefined) ??
        chunkAudioRef.current[cacheKey] ??
        (await requestChunkAudio(chunk, { voiceId, sessionId }));

      if (
        attemptId !== playbackAttemptRef.current ||
        sessionId !== generationSessionRef.current ||
        voiceId !== selectedVoiceIdRef.current ||
        currentDocument.documentId !== documentDataRef.current?.documentId
      ) {
        return;
      }

      void preloadNextChunks(safeIndex, sessionId, voiceId);

      const audio = audioRef.current;
      if (!audio) {
        return;
      }

      const nextSrc = `${API_BASE_URL}${data.audioUrl}`;
      const absoluteNextSrc = new URL(nextSrc, window.location.href).href;

      if (audio.src !== absoluteNextSrc) {
        audio.src = nextSrc;
        audio.load();
        await waitForAudioMetadata(audio);
      } else if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        await waitForAudioMetadata(audio);
      }

      if (
        attemptId !== playbackAttemptRef.current ||
        sessionId !== generationSessionRef.current ||
        voiceId !== selectedVoiceIdRef.current
      ) {
        return;
      }

      const safeStart = Math.max(0, Math.min(Math.max(0, data.duration - 0.01), startLocalSeconds));
      const currentPlaybackRate = playbackRateRef.current;
      audio.currentTime = safeStart;
      audio.defaultPlaybackRate = currentPlaybackRate;
      audio.playbackRate = currentPlaybackRate;
      audio.volume = audioContextRef.current ? 1 : 0;
      currentChunkLocalSecondsRef.current = safeStart;
      setCurrentChunkLocalSeconds(safeStart);

      await audio.play();

      if (
        attemptId !== playbackAttemptRef.current ||
        sessionId !== generationSessionRef.current ||
        voiceId !== selectedVoiceIdRef.current
      ) {
        clearAudioFadeSchedule();
        audio.pause();
        return;
      }

      setIsPlaying(true);
      setStatus(
        `${data.cached ? "Aus Cache" : "Neu erzeugt"}: Satz ${safeIndex + 1} / ${
          currentChunks.length
        } · Stimme: ${voiceId}`,
      );
    } catch (error) {
      if (error instanceof SkippedTtsChunkError && attemptId === playbackAttemptRef.current) {
        const nextIndex = safeIndex + 1;

        if (nextIndex < currentChunks.length) {
          await playChunk(nextIndex, 0);
        } else {
          setIsPlaying(false);
          setStatus("Keine weiteren vorlesbaren Inhalte gefunden.");
        }
        return;
      }

      if (!isAbortError(error) && attemptId === playbackAttemptRef.current) {
        const message = error instanceof Error ? error.message : String(error);
        setPlaybackError(formatPlaybackError(error));
        setStatus(`TTS-Fehler: ${message}`);
        setIsPlaying(false);
      }
    } finally {
      if (attemptId === playbackAttemptRef.current) {
        setIsLoadingAudio(false);
      }
    }
  }

  async function handlePlayPause() {
    if (!documentDataRef.current || (documentDataRef.current.chunks ?? []).length === 0) {
      return;
    }

    if (!playerVisible) {
      setPlayerVisible(true);
    }

    if (isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
      persistCurrentReaderState();
      return;
    }

    if (audioRef.current?.src && audioRef.current.currentTime > 0 && !audioRef.current.ended) {
      const currentPlaybackRate = playbackRateRef.current;
      ensureAudioGraph(audioRef.current);
      audioRef.current.defaultPlaybackRate = currentPlaybackRate;
      audioRef.current.playbackRate = currentPlaybackRate;
      await audioRef.current.play();
      setIsPlaying(true);
      return;
    }

    await playChunk(activeChunkIndexRef.current, currentChunkLocalSecondsRef.current);
  }

  function seekToUnit(unitId: string) {
    const currentChunks = documentDataRef.current?.chunks ?? [];
    const chunkIndex = currentChunks.findIndex((chunk) => chunk.unitIds.includes(unitId));

    if (chunkIndex === -1) {
      return;
    }

    persistCurrentReaderState();
    rotateGenerationSession();
    stopPlayback();
    setPlayerVisible(true);

    setActiveUnitId(unitId);
    selectedUnitIdRef.current = unitId;
    setSelectedUnitId(unitId);
    currentChunkLocalSecondsRef.current = 0;
    setCurrentChunkLocalSeconds(0);

    void playChunk(chunkIndex, 0);
  }

  function seekToGlobalTime(seconds: number) {
    const currentChunks = documentDataRef.current?.chunks ?? [];
    const voiceId = selectedVoiceIdRef.current;

    if (currentChunks.length === 0) {
      return;
    }

    let cursor = 0;

    for (let index = 0; index < currentChunks.length; index += 1) {
      const chunk = currentChunks[index];
      if (chunkShouldBeSkipped(chunk, skipContentSettingsRef.current)) {
        continue;
      }
      const cacheKey = voiceId ? buildAudioCacheKey(voiceId, chunk.id, skipContentSettingsRef.current) : "";
      const duration =
        (cacheKey ? chunkAudioRef.current[cacheKey]?.duration : undefined) ??
        estimatedPlayableDuration(chunk, skipContentSettingsRef.current);
      const end = cursor + duration;

      if (seconds >= cursor && seconds <= end) {
        persistCurrentReaderState();
        rotateGenerationSession();
        stopPlayback();
        void playChunk(index, Math.max(0, seconds - cursor));
        return;
      }

      cursor = end;
    }

    persistCurrentReaderState();
    rotateGenerationSession();
    stopPlayback();
    const lastPlayableIndex = findPlayableChunkIndex(
      currentChunks,
      currentChunks.length - 1,
      -1,
      skipContentSettingsRef.current,
    );
    if (lastPlayableIndex >= 0) {
      void playChunk(lastPlayableIndex, 0);
    }
  }

  function stopPlayback() {
    playbackAttemptRef.current += 1;
    clearAudioFadeSchedule();
    setAudioGainImmediately(0);

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }

    setIsPlaying(false);
    setIsLoadingAudio(false);
  }

  function clearReadingPlaybackHighlight() {
    setActiveUnitId("");
    selectedUnitIdRef.current = "";
    setSelectedUnitId("");
    activeWordIdRef.current = "";
    setActiveWordTiming(null);
    setHoveredUnitId("");
    lastAutoScrolledUnitIdRef.current = "";
  }

  function handleClosePlayer() {
    persistCurrentReaderState();
    rotateGenerationSession();
    stopPlayback();
    clearReadingPlaybackHighlight();
    setPlaybackError(null);
    setPlayerVisible(false);
    setStatus("Lesemodus");
  }

  function handleStartListening() {
    if (!documentDataRef.current || (documentDataRef.current.chunks ?? []).length === 0) {
      return;
    }

    setPlaybackError(null);
    setPlayerVisible(true);

    if (!hasVoice) {
      setStatus("Stimme herunterladen oder auswählen");
      return;
    }

    void handlePlayPause();
  }

  function closeCurrentDocument() {
    documentLoadAbortRef.current?.abort();
    documentLoadAbortRef.current = null;
    documentLoadRequestRef.current += 1;
    setOpeningDocumentId("");
    setOpeningDocumentFilename("");

    const currentDocument = documentDataRef.current;

    if (currentDocument) {
      persistCurrentReaderState();
    }
    rotateGenerationSession();
    stopPlayback();
    clearReadingPlaybackHighlight();
    clearTextSelection();
    closeMenus();
    setReaderDialog(null);
    setPlaybackError(null);
    setPlayerVisible(false);

    if (readerPersistTimerRef.current !== null) {
      window.clearTimeout(readerPersistTimerRef.current);
      readerPersistTimerRef.current = null;
    }

    documentDataRef.current = null;
    setDocumentData(null);
    setPdfDocument(null);
    setBookmarks([]);
    setTextHighlights([]);
    setChunkAudio({});
    chunkAudioRef.current = {};
    preloadInFlightRef.current.clear();
    activeChunkIndexRef.current = 0;
    setActiveChunkIndex(0);
    currentChunkLocalSecondsRef.current = 0;
    setCurrentChunkLocalSeconds(0);
    viewportPageNumberRef.current = 1;
    setViewportPageNumber(1);
    pageVisibilityRef.current = {};
    setVisiblePageNumbers([1]);
    pendingScrollRestoreRef.current = null;
    pageRefs.current = {};

    try {
      window.localStorage.removeItem(STORAGE_LAST_DOCUMENT);
    } catch {
      // localStorage can be unavailable in hardened/private browser contexts.
    }

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("document");
    window.history.replaceState({}, "", nextUrl);
    setStatus("Bibliothek");
  }

  function closeMenus() {
    setTopMenu(null);
    setAppearanceMenuOpen(false);
  }

  useEffect(() => {
    if (!topMenu) {
      return;
    }

    const handlePointerDownOutside = (event: PointerEvent) => {
      const menuRoot = readerMenuRef.current;
      const target = event.target;

      if (!menuRoot || !(target instanceof Node)) {
        return;
      }

      if (!menuRoot.contains(target)) {
        setTopMenu(null);
        setAppearanceMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTopMenu(null);
        setAppearanceMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDownOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDownOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [topMenu]);

  function persistBookmarks(nextBookmarks: Bookmark[]) {
    const documentId = documentDataRef.current?.documentId;
    setBookmarks(nextBookmarks);
    if (!documentId) {
      return;
    }

    try {
      window.localStorage.setItem(`${STORAGE_BOOKMARK_PREFIX}${documentId}`, JSON.stringify(nextBookmarks));
    } catch {
      // Ignore unavailable storage contexts.
    }
  }

  function persistTextHighlights(nextHighlights: TextHighlight[]) {
    const documentId = documentDataRef.current?.documentId;
    setTextHighlights(nextHighlights);

    if (!documentId) {
      return;
    }

    try {
      window.localStorage.setItem(`${STORAGE_HIGHLIGHT_PREFIX}${documentId}`, JSON.stringify(nextHighlights));
    } catch {
      // Ignore unavailable storage contexts.
    }
  }

  function clearTextSelection() {
    selectionAnchorWordIdRef.current = "";
    selectionFocusWordIdRef.current = "";
    selectionDidDragRef.current = false;
    selectionDraftRef.current = null;
    setSelectionDraft(null);
    setSelectionMenuPosition(null);
    setSelectionNoteOpen(false);
    setSelectionNoteText("");
    setSelectionNoteColor("yellow");
    setSelectionNoteColorOpen(false);
    setSelectionCopied(false);
  }

  function selectedTextFromWords(words: PdfWord[]) {
    return words
      .map((word) => word.text)
      .join(" ")
      .replace(/\s+([,.;:!?%)}\]])/g, "$1")
      .replace(/([({\[])\s+/g, "$1")
      .replace(/\s+([’'])\s+/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildSelectionDraft(anchorWordId: string, focusWordId: string): SelectionDraft | null {
    const anchorIndex = wordIndexById.get(anchorWordId);
    const focusIndex = wordIndexById.get(focusWordId);

    if (anchorIndex === undefined || focusIndex === undefined) {
      return null;
    }

    const start = Math.min(anchorIndex, focusIndex);
    const end = Math.max(anchorIndex, focusIndex);
    const words = orderedWords.slice(start, end + 1);

    if (words.length === 0) {
      return null;
    }

    return {
      wordIds: words.map((word) => word.id),
      text: selectedTextFromWords(words),
    };
  }

  function findWordAtPointer(pageNumber: number, event: ReactPointerEvent<HTMLElement>): PdfWord | null {
    const scale = pageScaleByNumber.get(pageNumber) ?? 1;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / scale;
    const y = (event.clientY - bounds.top) / scale;
    const pageWords = wordsByPage.get(pageNumber) ?? [];
    const tolerance = 2.5;

    let nearest: PdfWord | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const word of pageWords) {
      if (
        x >= word.x0 - tolerance &&
        x <= word.x1 + tolerance &&
        y >= word.y0 - tolerance &&
        y <= word.y1 + tolerance
      ) {
        return word;
      }

      const centerX = (word.x0 + word.x1) / 2;
      const centerY = (word.y0 + word.y1) / 2;
      const dx = centerX - x;
      const dy = centerY - y;
      const distance = dx * dx + dy * dy;

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = word;
      }
    }

    return nearestDistance <= 225 ? nearest : null;
  }

  function updateHoverFromWord(word: PdfWord | null) {
    if (!playerVisible || !clickToReadEnabled) {
      setHoveredUnitId((current) => current ? "" : current);
      return;
    }

    const unitId = word ? wordToUnitId.get(word.id) ?? "" : "";
    setHoveredUnitId((current) => current === unitId ? current : unitId);
  }

  function handlePagePointerDown(pageNumber: number, event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) {
      return;
    }

    const word = findWordAtPointer(pageNumber, event);
    if (!word) {
      clearTextSelection();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const draft = buildSelectionDraft(word.id, word.id);
    selectionAnchorWordIdRef.current = word.id;
    selectionFocusWordIdRef.current = word.id;
    selectionDidDragRef.current = false;
    selectionDraftRef.current = draft;
    setSelectionDraft(draft);
    setSelectionMenuPosition(null);
    setSelectionNoteOpen(false);
    setSelectionNoteText("");
    setSelectionNoteColor("yellow");
    setSelectionCopied(false);
    updateHoverFromWord(word);
  }

  function handlePagePointerMove(pageNumber: number, event: ReactPointerEvent<HTMLElement>) {
    const word = findWordAtPointer(pageNumber, event);
    updateHoverFromWord(word);

    const anchorWordId = selectionAnchorWordIdRef.current;
    if (!anchorWordId || (event.buttons & 1) !== 1 || !word) {
      return;
    }

    if (word.id === selectionFocusWordIdRef.current) {
      return;
    }

    selectionFocusWordIdRef.current = word.id;

    if (word.id !== anchorWordId) {
      selectionDidDragRef.current = true;
    }

    const draft = buildSelectionDraft(anchorWordId, word.id);
    if (!draft) {
      return;
    }

    selectionDraftRef.current = draft;
    setSelectionDraft(draft);
  }

  function handlePagePointerUp(pageNumber: number, event: ReactPointerEvent<HTMLElement>) {
    const anchorWordId = selectionAnchorWordIdRef.current;
    if (!anchorWordId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const pointerWord = findWordAtPointer(pageNumber, event);
    const focusWordId = pointerWord?.id || selectionFocusWordIdRef.current || anchorWordId;
    const didDrag = selectionDidDragRef.current;
    const draft = buildSelectionDraft(anchorWordId, focusWordId) ?? selectionDraftRef.current;

    selectionAnchorWordIdRef.current = "";
    selectionFocusWordIdRef.current = "";
    selectionDidDragRef.current = false;

    if (!didDrag) {
      clearTextSelection();
      const word = wordById.get(focusWordId);
      const unitId = word ? wordToUnitId.get(word.id) : "";

      if (playerVisible && clickToReadEnabled && unitId) {
        seekToUnit(unitId);
      }

      return;
    }

    if (!draft || draft.wordIds.length === 0) {
      clearTextSelection();
      return;
    }

    selectionDraftRef.current = draft;
    setSelectionDraft(draft);

    const toolbarHalfWidth = 178;
    const left = Math.max(
      toolbarHalfWidth + 12,
      Math.min(window.innerWidth - toolbarHalfWidth - 12, event.clientX),
    );
    const top = Math.max(96, event.clientY - 14);
    setSelectionMenuPosition({ left, top });
  }

  function handlePagePointerCancel(event: ReactPointerEvent<HTMLElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    selectionAnchorWordIdRef.current = "";
    selectionFocusWordIdRef.current = "";
    selectionDidDragRef.current = false;
  }

  function addSelectionHighlight(color: TextMarkColor, note = "") {
    const draft = selectionDraftRef.current;
    if (!draft || draft.wordIds.length === 0) {
      return;
    }

    const wordKey = draft.wordIds.join("|");
    const withoutSameSelection = textHighlights.filter((highlight) => highlight.wordIds.join("|") !== wordKey);
    const nextHighlights = [
      ...withoutSameSelection,
      {
        id: `highlight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        color,
        text: draft.text,
        wordIds: [...draft.wordIds],
        note: note.trim(),
        createdAt: Date.now(),
      },
    ];

    persistTextHighlights(nextHighlights);
    setStatus(note.trim() ? "Markierung mit Notiz gespeichert." : "Text markiert.");
    clearTextSelection();
  }

  async function copySelectionText() {
    const draft = selectionDraftRef.current;
    if (!draft?.text) {
      return;
    }

    try {
      await navigator.clipboard.writeText(draft.text);
      setSelectionCopied(true);
      setStatus("Ausgewählter Text kopiert.");

      window.setTimeout(() => {
        clearTextSelection();
      }, 850);
    } catch {
      setStatus("Kopieren fehlgeschlagen.");
    }
  }

  function saveSelectionNote() {
    const note = selectionNoteText.trim();
    if (!note) {
      return;
    }
    addSelectionHighlight(selectionNoteColor, note);
  }

  function goToTextHighlight(highlight: TextHighlight) {
    const firstWord = highlight.wordIds.map((wordId) => wordById.get(wordId)).find(Boolean);
    if (!firstWord) {
      return;
    }

    const pageElement = pageRefs.current[firstWord.pageNumber];
    if (!pageElement) {
      return;
    }

    programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
    pageElement.scrollIntoView({ behavior: "smooth", block: "center" });
    setReaderDialog(null);
  }

  function buildWordLineRects(wordIds: string[], pageNumber: number, scale: number) {
    const groups = new Map<string, PdfWord[]>();

    for (const wordId of wordIds) {
      const word = wordById.get(wordId);
      if (!word || word.pageNumber !== pageNumber) {
        continue;
      }
      const key = `${word.blockNumber}:${word.lineNumber}`;
      const group = groups.get(key) ?? [];
      group.push(word);
      groups.set(key, group);
    }

    return Array.from(groups.values())
      .map((words) => {
        const x0 = Math.min(...words.map((word) => word.x0));
        const y0 = Math.min(...words.map((word) => word.y0));
        const x1 = Math.max(...words.map((word) => word.x1));
        const y1 = Math.max(...words.map((word) => word.y1));
        const padX = 1.3 * scale;
        const padY = 0.8 * scale;
        return {
          left: x0 * scale - padX,
          top: y0 * scale - padY,
          width: (x1 - x0) * scale + padX * 2,
          height: (y1 - y0) * scale + padY * 2,
        };
      })
      .sort((left, right) => left.top - right.top || left.left - right.left);
  }

  function addCurrentBookmark() {
    const position = currentPagePosition();
    if (!position || !documentDataRef.current) {
      return;
    }

    if (bookmarks.some((bookmark) => bookmark.pageNumber === position.pageNumber)) {
      setStatus(`Seite ${position.pageNumber} ist bereits als Lesezeichen gespeichert.`);
      return;
    }

    const nextBookmarks = [
      ...bookmarks,
      {
        id: `${Date.now()}-${position.pageNumber}`,
        pageNumber: position.pageNumber,
        createdAt: Date.now(),
      },
    ].sort((a, b) => a.pageNumber - b.pageNumber);

    persistBookmarks(nextBookmarks);
    setStatus(`Lesezeichen für Seite ${position.pageNumber} hinzugefügt.`);
  }

  function goToBookmark(pageNumber: number) {
    const element = pageRefs.current[pageNumber];
    if (!element) {
      return;
    }

    programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    setReaderDialog(null);
  }

  async function renameCurrentDocument() {
    const currentDocument = documentDataRef.current;
    const filename = renameValue.trim();
    if (!currentDocument || !filename) {
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/documents/${currentDocument.documentId}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const result = (await response.json()) as { filename: string };
      setDocumentData((previous) => (previous ? { ...previous, filename: result.filename } : previous));
      documentDataRef.current = documentDataRef.current
        ? { ...documentDataRef.current, filename: result.filename }
        : null;
      await loadDocuments();
      setReaderDialog(null);
      setStatus(`Umbenannt in ${result.filename}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Umbenennen fehlgeschlagen: ${message}`);
    }
  }

  async function downloadCurrentDocument() {
    const currentDocument = documentDataRef.current;
    if (!currentDocument) {
      return;
    }

    closeMenus();
    setStatus("PDF mit Hervorhebungen und Notizen wird erstellt ...");

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/documents/${encodeURIComponent(currentDocument.documentId)}/export`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ highlights: textHighlights }),
        },
      );

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = currentDocument.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setStatus(`Heruntergeladen: ${currentDocument.filename}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Herunterladen fehlgeschlagen: ${message}`);
    }
  }

  async function deleteCurrentDocument() {
    const currentDocument = documentDataRef.current;
    if (!currentDocument) {
      return;
    }

    const confirmed = window.confirm(`„${currentDocument.filename}“ wirklich löschen?`);
    if (!confirmed) {
      return;
    }

    closeMenus();
    persistCurrentReaderState();
    rotateGenerationSession();
    stopPlayback();
    clearReadingPlaybackHighlight();
    clearTextSelection();
    setPlayerVisible(false);
    setStatus(`Lösche ${currentDocument.filename} ...`);

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/documents/${encodeURIComponent(currentDocument.documentId)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        throw new Error(await response.text());
      }

      try {
        window.localStorage.removeItem(`${STORAGE_READER_PREFIX}${currentDocument.documentId}`);
        window.localStorage.removeItem(`${STORAGE_BOOKMARK_PREFIX}${currentDocument.documentId}`);
        window.localStorage.removeItem(`${STORAGE_HIGHLIGHT_PREFIX}${currentDocument.documentId}`);
        window.localStorage.removeItem(STORAGE_LAST_DOCUMENT);
      } catch {
      }

      documentDataRef.current = null;
      setDocumentData(null);
      setPdfDocument(null);
      setBookmarks([]);
      setTextHighlights([]);
      setChunkAudio({});
      chunkAudioRef.current = {};
      activeChunkIndexRef.current = 0;
      setActiveChunkIndex(0);
      currentChunkLocalSecondsRef.current = 0;
      setCurrentChunkLocalSeconds(0);
      pendingScrollRestoreRef.current = null;

      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete("document");
      window.history.replaceState({}, "", nextUrl);

      const remainingDocuments = await loadDocuments();
      if (remainingDocuments.length > 0) {
        await loadDocument(remainingDocuments[0].documentId);
      } else {
        setStatus("Dokument gelöscht. Keine PDF geladen.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Löschen fehlgeschlagen: ${message}`);
    }
  }

  function updateSkipCategory(category: SkipCategory, enabled: boolean) {
    const nextSettings = {
      ...skipContentSettingsRef.current,
      [category]: enabled,
    };

    skipContentSettingsRef.current = nextSettings;
    setSkipContentSettings(nextSettings);

    persistCurrentReaderState();
    rotateGenerationSession();
    stopPlayback();
    clearReadingPlaybackHighlight();
    currentChunkLocalSecondsRef.current = 0;
    setCurrentChunkLocalSeconds(0);
    setStatus("Überspringregeln aktualisiert.");
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (file) {
      setAddDocumentDialogOpen(false);
      void uploadPdf(file);
    }

    event.target.value = "";
  }

  function handleAddDocumentDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);

    const file = event.dataTransfer.files?.[0];
    if (!file) {
      return;
    }

    setAddDocumentDialogOpen(false);
    void uploadPdf(file);
  }

  function showLibraryHome() {
    setAddDocumentDialogOpen(false);

    if (documentDataRef.current) {
      closeCurrentDocument();
      return;
    }

    closeMenus();
    setReaderDialog(null);
    clearTextSelection();
    setStatus("Bibliothek");
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
    if (!nextVoiceId || nextVoiceId === selectedVoiceIdRef.current) {
      return;
    }

    persistCurrentReaderState();
    rotateGenerationSession();
    stopPlayback();
    setPlaybackError(null);

    selectedVoiceIdRef.current = nextVoiceId;
    setSelectedVoiceId(nextVoiceId);
    window.localStorage.setItem(STORAGE_SELECTED_VOICE, nextVoiceId);

    chunkAudioRef.current = {};
    setChunkAudio({});
    preloadInFlightRef.current.clear();
    lastAutoScrolledUnitIdRef.current = "";
    programmaticScrollUntilRef.current = 0;

    currentChunkLocalSecondsRef.current = 0;
    setCurrentChunkLocalSeconds(0);
    setStatus(`Stimme ausgewählt: ${nextVoiceId}`);
    schedulePersistCurrentReaderState(0);
  }

  function handlePlaybackRateChange(rate: number) {
    const nextRate = Math.max(0.5, Math.min(2.5, rate));

    playbackRateRef.current = nextRate;
    setPlaybackRate(nextRate);

    const audio = audioRef.current;
    if (audio) {
      audio.defaultPlaybackRate = nextRate;
      audio.playbackRate = nextRate;
    }
  }

  function handleAutoScrollChange(enabled: boolean) {
    setAutoScrollEnabled(enabled);
    autoScrollEnabledRef.current = enabled;
    schedulePersistCurrentReaderState();

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

    const pageUnits = unitsByPage.get(page.pageNumber) ?? [];

    const scale = pageScaleByNumber.get(page.pageNumber) ?? 1;
    const activeId = activeUnit?.unitId ?? "";

    const savedHighlightRects = textHighlights.flatMap((highlight) =>
      buildWordLineRects(highlight.wordIds, page.pageNumber, scale).map((rect, index) => (
        <div
          className={`saved-text-highlight mark-${highlight.color}`}
          key={`${highlight.id}-${page.pageNumber}-${index}`}
          style={{
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          }}
        />
      )),
    );

    const draftSelectionRects = selectionDraft
      ? buildWordLineRects(selectionDraft.wordIds, page.pageNumber, scale).map((rect, index) => (
          <div
            className="draft-text-selection"
            key={`draft-selection-${page.pageNumber}-${index}`}
            style={{
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
            }}
          />
        ))
      : [];

    const sentenceHighlights = pageUnits.flatMap((unit) => {
      const active = playerVisible && sentenceHighlightEnabled && isPlaying && unit.unitId === activeId;
      const selected = playerVisible && sentenceHighlightEnabled && unit.unitId === selectedUnitId;
      const hovered = playerVisible && clickToReadEnabled && unit.unitId === hoveredUnitId;
      const rects = unit.lineRects?.filter((rect) => rect.pageNumber === page.pageNumber) ?? [];

      const effectiveRects = rects.length > 0
        ? rects.map((rect) => [rect.x0, rect.y0, rect.x1, rect.y1])
        : unit.pageNumber === page.pageNumber
          ? unit.lineBoxes
          : [];

      return effectiveRects.map((box, index) => {
        const left = box[0] * scale;
        const top = box[1] * scale;
        const width = (box[2] - box[0]) * scale;
        const height = (box[3] - box[1]) * scale;

        return (
          <div
            className={`segment-hitbox ${hovered ? "hovered" : ""} ${selected ? "selected" : ""} ${active ? "active" : ""}`}
            data-unit-id={unit.unitId}
            key={`${unit.unitId}-${page.pageNumber}-${index}`}
            style={{
              left: `${left}px`,
              top: `${top}px`,
              width: `${width}px`,
              height: `${height}px`,
            }}
          />
        );
      });
    });

    let wordHighlight = null;

    if (playerVisible && isPlaying && activeWordTiming && activeWordTiming.pageNumber === page.pageNumber) {
      const horizontalPadding = 1.8 * scale;
      const verticalPadding = 1.1 * scale;
      const left = activeWordTiming.x0 * scale - horizontalPadding;
      const top = activeWordTiming.y0 * scale - verticalPadding;
      const width = (activeWordTiming.x1 - activeWordTiming.x0) * scale + horizontalPadding * 2;
      const height = (activeWordTiming.y1 - activeWordTiming.y0) * scale + verticalPadding * 2;

      wordHighlight = (
        <div
          className="active-word-highlight"
          key={`active-word-${activeWordTiming.wordId}`}
          style={{
            left: `${left}px`,
            top: `${top}px`,
            width: `${width}px`,
            height: `${height}px`,
          }}
        />
      );
    }

    const interactionLayer = (
      <div
        className="page-interaction-layer"
        data-page-number={page.pageNumber}
        onPointerDown={(event) => handlePagePointerDown(page.pageNumber, event)}
        onPointerMove={(event) => handlePagePointerMove(page.pageNumber, event)}
        onPointerUp={(event) => handlePagePointerUp(page.pageNumber, event)}
        onPointerCancel={handlePagePointerCancel}
        onPointerLeave={() => {
          if (!selectionAnchorWordIdRef.current) {
            setHoveredUnitId("");
          }
        }}
      />
    );

    return (
      <>
        {savedHighlightRects}
        {sentenceHighlights}
        {draftSelectionRects}
        {wordHighlight}
        {interactionLayer}
      </>
    );
  }

  useEffect(() => {
    if (!playerVisible || !clickToReadEnabled) {
      setHoveredUnitId("");
    }
  }, [playerVisible, clickToReadEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_SIDEBAR_COLLAPSED, sidebarCollapsed ? "1" : "0");
    } catch {
      // localStorage can be unavailable in hardened/private browser contexts.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!addDocumentDialogOpen) {
      return;
    }

    function handleAddDocumentDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAddDocumentDialogOpen(false);
      }
    }

    document.addEventListener("keydown", handleAddDocumentDialogKeyDown);
    return () => document.removeEventListener("keydown", handleAddDocumentDialogKeyDown);
  }, [addDocumentDialogOpen]);

  const appliedTheme: "light" | "dark" = themeMode === "system" ? (systemPrefersDark ? "dark" : "light") : themeMode;

  return (
    <main className={`app-shell theme-${appliedTheme} cursor-color-${cursorColor} ${sidebarCollapsed ? "sidebar-collapsed" : "sidebar-expanded"}`}>
      <audio ref={audioRef} crossOrigin="anonymous" />

      <aside className="library-sidebar">
        <div className="brand-row">
          <img className="brand-logo" src="/smartvoice-logo.webp" alt="SmartVoice" />
          <span className="brand-wordmark-wrap">
            <SmartVoiceWordmark />
          </span>
        </div>

        <button
          className="add-document-button"
          type="button"
          disabled={isUploading}
          onClick={() => setAddDocumentDialogOpen(true)}
        >
          <span className="add-document-icon">＋</span>
          <span>Hinzufügen</span>
        </button>

        <nav className="library-nav" aria-label="Dokumente">
          <div className="library-search-placeholder">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="m12.4 12.4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span>Suchen</span>
          </div>

          <div
            ref={documentListRef}
            className="document-list"
          >
            {documents.length === 0 && <div className="document-list-empty">Noch keine Dateien</div>}
            {documents.map((document) => {
              const activeDocumentId = openingDocumentId || documentData?.documentId || "";
              const active = document.documentId === activeDocumentId;
              const previewSrc = toApiAssetUrl(document.previewImageUrl);
              const dragging = draggedDocumentId === document.documentId;

              return (
                <button
                  ref={(element) => {
                    documentItemRefs.current[document.documentId] = element;
                  }}
                  data-document-id={document.documentId}
                  className={`document-list-item ${active ? "active" : ""} ${dragging ? "dragging" : ""}`}
                  type="button"
                  key={document.documentId}
                  onClick={() => {
                    if (performance.now() < suppressDocumentClickUntilRef.current) {
                      return;
                    }

                    void loadDocument(document.documentId);
                  }}
                  onPointerDown={(event) => {
                    if (
                      event.button !== 0 ||
                      (event.pointerType === "touch" && !event.isPrimary)
                    ) {
                      return;
                    }

                    const sourceRect = event.currentTarget.getBoundingClientRect();

                    documentPointerDragRef.current = {
                      pointerId: event.pointerId,
                      documentId: document.documentId,
                      startX: event.clientX,
                      startY: event.clientY,
                      dragging: false,
                    };

                    documentDropTargetRef.current = null;
                                    setDocumentDragPreviewMetrics({
                      offsetX: event.clientX - sourceRect.left,
                      offsetY: event.clientY - sourceRect.top,
                      width: sourceRect.width,
                    });

                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    const drag = documentPointerDragRef.current;

                    if (!drag || drag.pointerId !== event.pointerId) {
                      return;
                    }

                    const deltaX = event.clientX - drag.startX;
                    const deltaY = event.clientY - drag.startY;

                    if (!drag.dragging) {
                      if (Math.hypot(deltaX, deltaY) < 5) {
                        return;
                      }

                      drag.dragging = true;
                      setDraggedDocumentId(drag.documentId);
                    }

                    event.preventDefault();
                    updateDocumentDragPreview(event.clientX, event.clientY);
                    updateDocumentPointerDropTarget(
                      drag.documentId,
                      event.clientX,
                      event.clientY,
                    );
                  }}
                  onPointerUp={(event) => {
                    const drag = documentPointerDragRef.current;

                    if (!drag || drag.pointerId !== event.pointerId) {
                      return;
                    }

                    if (drag.dragging) {
                      event.preventDefault();
                      suppressDocumentClickUntilRef.current = performance.now() + 300;
                    }

                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }

                    resetDocumentPointerDrag();
                  }}
                  onPointerCancel={(event) => {
                    const drag = documentPointerDragRef.current;

                    if (!drag || drag.pointerId !== event.pointerId) {
                      return;
                    }

                    suppressDocumentClickUntilRef.current = performance.now() + 300;

                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }

                    resetDocumentPointerDrag();
                  }}
                >
                  <span className="document-preview-shell">
                    {previewSrc ? (
                      <img
                        className="document-preview-image"
                        src={previewSrc}
                        alt=""
                        loading="lazy"
                        draggable={false}
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                          const fallback = event.currentTarget.nextElementSibling as HTMLElement | null;
                          if (fallback) {
                            fallback.style.display = "grid";
                          }
                        }}
                      />
                    ) : null}
                    <span className="document-file-icon" style={{ display: previewSrc ? "none" : "grid" }}>PDF</span>
                  </span>
                  <span className="document-file-name">{document.filename}</span>
                </button>
              );
            })}
          </div>
        </nav>

        <nav className="sidebar-compact-actions" aria-label="Schnellzugriff">
          <button
            type="button"
            className="sidebar-compact-button"
            disabled={isUploading}
            onClick={() => setAddDocumentDialogOpen(true)}
            aria-label="Dokument hinzufügen"
            title="Hinzufügen"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>

          <button
            type="button"
            className={`sidebar-compact-button ${!documentData ? "active" : ""}`}
            onClick={showLibraryHome}
            aria-label="Bibliothek öffnen"
            title="Bibliothek"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="5" y="4.5" width="11" height="13" rx="2" />
              <rect x="8" y="7.5" width="11" height="12" rx="2" />
            </svg>
          </button>
        </nav>

        <button
          type="button"
          className="sidebar-collapse-handle"
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();

            const relativeX = Math.max(
              0,
              Math.min(event.clientX - rect.left, rect.width),
            );

            const relativeY = Math.max(
              24,
              Math.min(event.clientY - rect.top, rect.height - 24),
            );

            event.currentTarget.style.setProperty("--sidebar-handle-x", `${relativeX}px`);
            event.currentTarget.style.setProperty("--sidebar-handle-y", `${relativeY}px`);
          }}
          onClick={() => setSidebarCollapsed((current) => !current)}
          aria-label={sidebarCollapsed ? "Sidebar ausklappen" : "Sidebar einklappen"}
          aria-expanded={!sidebarCollapsed}
        >
          <span className="sidebar-collapse-grip" aria-hidden="true">
            <svg viewBox="0 0 28 22">
              <path
                className={`sidebar-direction-arrow left ${!sidebarCollapsed ? "available" : ""}`}
                d="M11.2 5.2 5.8 11l5.4 5.8Z"
              />
              <path
                className={`sidebar-direction-arrow right ${sidebarCollapsed ? "available" : ""}`}
                d="m16.8 5.2 5.4 5.8-5.4 5.8Z"
              />
            </svg>
          </span>
        </button>
      </aside>

      <section className="reader-shell">
        <header className="reader-topbar">
          <div className="reader-title-group">
            <strong>{openingDocumentFilename || documentData?.filename || "Bibliothek"}</strong>
            {documentData && !openingDocumentId && (
              <nav className="reader-menu" aria-label="Dokumentmenü" ref={readerMenuRef}>
                <div className="reader-menu-item-wrap">
                  <button
                    type="button"
                    className={topMenu === "file" ? "active" : ""}
                    onClick={() => setTopMenu((current) => (current === "file" ? null : "file"))}
                  >
                    Datei
                  </button>
                  {topMenu === "file" && (
                    <div className="topbar-menu file-menu">
                      <button type="button" onClick={() => { setRenameValue(documentData.filename); setReaderDialog("rename"); closeMenus(); }}>
                        <span className="menu-icon">✎</span><span>Umbenennen</span>
                      </button>
                      <div className="menu-divider" />
                      <button type="button" onClick={() => void downloadCurrentDocument()}>
                        <span className="menu-icon">⇩</span><span>Herunterladen</span>
                      </button>
                      <button type="button" className="danger" onClick={() => void deleteCurrentDocument()}>
                        <span className="menu-icon">⌫</span><span>Löschen</span>
                      </button>
                    </div>
                  )}
                </div>

                <div className="reader-menu-item-wrap">
                  <button
                    type="button"
                    className={topMenu === "notes" ? "active" : ""}
                    onClick={() => setTopMenu((current) => (current === "notes" ? null : "notes"))}
                  >
                    Notizen
                  </button>
                  {topMenu === "notes" && (
                    <div className="topbar-menu notes-menu">
                      <button type="button" onClick={() => { setReaderDialog("highlights"); closeMenus(); }}>
                        <span className="menu-icon">✎</span><span>Hervorhebungen &amp; Notizen</span>
                      </button>
                    </div>
                  )}
                </div>

                <div className="reader-menu-item-wrap">
                  <button
                    type="button"
                    className={topMenu === "settings" ? "active" : ""}
                    onClick={() => { setAppearanceMenuOpen(false); setTopMenu((current) => (current === "settings" ? null : "settings")); }}
                  >
                    Einstellungen
                  </button>
                  {topMenu === "settings" && (
                    <div className="topbar-menu settings-menu">
                      <button
                        type="button"
                        className={`settings-action-row settings-appearance-row ${appearanceMenuOpen ? "active" : ""}`}
                        onClick={() => setAppearanceMenuOpen((open) => !open)}
                        aria-expanded={appearanceMenuOpen}
                      >
                        <span className="menu-icon">◐</span>
                        <span>App-Design</span>
                        <span className="settings-appearance-value">
                          {themeMode === "dark" ? "Dunkel" : themeMode === "light" ? "Hell" : `System (${systemPrefersDark ? "dunkel" : "hell"})`}
                          <span className="menu-chevron">›</span>
                        </span>
                      </button>
                      {appearanceMenuOpen && (
                        <div className="appearance-submenu" role="menu" aria-label="App-Design">
                          <button
                            type="button"
                            className={themeMode === "system" ? "selected" : ""}
                            onClick={() => setThemeMode("system")}
                          >
                            <span className="appearance-icon">◐</span>
                            <span>{`System (${systemPrefersDark ? "dunkles" : "helles"} Design)`}</span>
                            <span className="appearance-check">{themeMode === "system" ? "✓" : ""}</span>
                          </button>
                          <button
                            type="button"
                            className={themeMode === "light" ? "selected" : ""}
                            onClick={() => setThemeMode("light")}
                          >
                            <span className="appearance-icon">☼</span>
                            <span>Hell</span>
                            <span className="appearance-check">{themeMode === "light" ? "✓" : ""}</span>
                          </button>
                          <button
                            type="button"
                            className={themeMode === "dark" ? "selected" : ""}
                            onClick={() => setThemeMode("dark")}
                          >
                            <span className="appearance-icon">◔</span>
                            <span>Dunkel</span>
                            <span className="appearance-check">{themeMode === "dark" ? "✓" : ""}</span>
                          </button>
                        </div>
                      )}
                      <div className="settings-color-row">
                        <span className="menu-icon">a</span><span>Cursorfarbe</span>
                        <div className="cursor-colors-inline">
                          {(["blue", "pink", "red", "clear", "orange"] as CursorColor[]).map((color) => (
                            <button
                              type="button"
                              key={color}
                              className={`cursor-color-dot ${color} ${cursorColor === color ? "selected" : ""}`}
                              onClick={() => setCursorColor(color)}
                              aria-label={`Cursorfarbe ${color}`}
                            />
                          ))}
                        </div>
                      </div>
                      <label className="settings-toggle-row">
                        <span className="settings-toggle-spacer" /><span>Satz hervorheben</span>
                        <input type="checkbox" checked={sentenceHighlightEnabled} onChange={(event) => setSentenceHighlightEnabled(event.target.checked)} />
                        <span className="toggle-switch" />
                      </label>
                      <div className="menu-divider" />
                      <button type="button" className="settings-action-row" onClick={() => { setReaderDialog("skip-content"); closeMenus(); }}>
                        <span className="menu-icon">↷</span>
                        <span className="settings-text"><strong>Inhalte automatisch überspringen</strong><small>Kopf-/Fußzeilen, Tabellen, Zitate usw.</small></span>
                        <span className="menu-chevron">›</span>
                      </button>
                      <label className="settings-toggle-row two-line">
                        <span className="menu-icon">↖</span>
                        <span className="settings-text"><strong>Zum Vorlesen klicken</strong><small>Beginnen Sie jeden Satz</small></span>
                        <input type="checkbox" checked={clickToReadEnabled} onChange={(event) => setClickToReadEnabled(event.target.checked)} />
                        <span className="toggle-switch" />
                      </label>
                      <label className="settings-toggle-row two-line">
                        <span className="menu-icon">ⓘ</span>
                        <span className="settings-text"><strong>Statusinformationen anzeigen</strong><small>Lade- und TTS-Status rechts oben anzeigen</small></span>
                        <input
                          type="checkbox"
                          checked={showStatusInformation}
                          onChange={(event) => setShowStatusInformation(event.target.checked)}
                        />
                        <span className="toggle-switch" />
                      </label>
                    </div>
                  )}
                </div>
              </nav>
            )}
          </div>

          <div className="reader-topbar-actions">
            {showStatusInformation && (documentData || isUploading || openingDocumentId) && (
              <div className="reader-status">
                <span className={isUploading || isLoadingAudio || openingDocumentId ? "status-spinner" : "status-dot"} />
                <span>{status}</span>
              </div>
            )}
            {(documentData || openingDocumentId) && (
              <button
                type="button"
                className="reader-document-close"
                onClick={closeCurrentDocument}
                aria-label="Dokument schließen und zur Bibliothek zurückkehren"
                title="Dokument schließen"
              >
                ×
              </button>
            )}
          </div>
        </header>

        {openingDocumentId ? (
          <section className="viewer document-switch-loading" aria-label="Dokument wird geöffnet">
            {[0, 1].map((pageIndex) => (
              <article className="document-switch-skeleton-page" key={pageIndex} aria-hidden="true">
                <div className="document-switch-skeleton-content">
                  <span className="document-switch-skeleton-heading" />
                  <span className="document-switch-skeleton-line wide" />
                  <span className="document-switch-skeleton-line wide" />
                  <span className="document-switch-skeleton-line medium" />
                  <span className="document-switch-skeleton-gap" />
                  <span className="document-switch-skeleton-line wide" />
                  <span className="document-switch-skeleton-line wide" />
                  <span className="document-switch-skeleton-line short" />
                  <span className="document-switch-skeleton-gap small" />
                  <span className="document-switch-skeleton-line wide" />
                  <span className="document-switch-skeleton-line medium" />
                  <span className="document-switch-skeleton-line wide" />
                  <span className="document-switch-skeleton-line short" />
                </div>
              </article>
            ))}
          </section>
        ) : documentData ? (
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
  
            {pages.map((page) => {
              const renderPriority = pdfRenderPlan.get(page.pageNumber);
              const shouldRenderPage = renderPriority !== undefined;

              return (
                <article
                  className="page-card"
                  data-page-number={page.pageNumber}
                  key={`${documentData.documentId}:${page.pageNumber}`}
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
                    {shouldRenderPage ? (
                      <>
                        <PdfPageCanvas
                          pdfDocument={pdfDocument}
                          pageNumber={page.pageNumber}
                          displayScale={(documentData?.renderZoom ?? 2.0) * zoom}
                          cssWidth={page.width * zoom}
                          cssHeight={page.height * zoom}
                          viewerRef={viewerRef}
                          renderPriority={renderPriority}
                        />
                        {renderUnitHighlights(page)}
                      </>
                    ) : (
                      <div className="virtual-page-placeholder" aria-hidden="true" />
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        ) : (
        <section
          className={`library-home ${isDragging ? "dragging" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isUploading ? (
            <div className="library-home-loading">
              <span className="large-spinner" />
              <strong>{status}</strong>
            </div>
          ) : documents.length === 0 ? (
            <div className="library-home-empty">
              <div className="library-home-empty-icon">PDF</div>
              <h2>Noch keine Dokumente</h2>
              <p>Füge eine PDF hinzu, um sie hier in deiner Bibliothek zu sehen.</p>
              <label className="empty-add-button">
                <span>＋</span>
                <span>Hinzufügen</span>
                <input type="file" accept="application/pdf,.pdf" onChange={handleFileInput} />
              </label>
            </div>
          ) : (
            <div className="library-history">
              <div className="library-history-columns" aria-hidden="true">
                <span>Name</span>
                <span>Typ</span>
                <span>Datum</span>
                <span>Fortschritt</span>
              </div>

              {libraryDocumentGroups.map((group) => (
                <section className="library-history-group" key={group.label}>
                  <h2>{group.label}</h2>
                  <div className="library-history-rows">
                    {group.documents.map((document) => {
                      const progress = documentProgressPercent(document);
                      const previewSrc = toApiAssetUrl(document.previewImageUrl);

                      return (
                        <button
                          type="button"
                          className="library-history-row"
                          key={document.documentId}
                          onClick={() => void loadDocument(document.documentId)}
                        >
                          <span className="library-history-name">
                            <span className="library-history-preview-shell">
                              {previewSrc ? (
                                <img
                                  className="library-history-preview-image"
                                  src={previewSrc}
                                  alt=""
                                  loading="lazy"
                                  onError={(event) => {
                                    event.currentTarget.style.display = "none";
                                    const fallback = event.currentTarget.nextElementSibling as HTMLElement | null;
                                    if (fallback) {
                                      fallback.style.display = "grid";
                                    }
                                  }}
                                />
                              ) : null}
                              <span
                                className="document-file-icon library-history-preview-fallback"
                                style={{ display: previewSrc ? "none" : "grid" }}
                              >
                                PDF
                              </span>
                            </span>
                            <span className="library-history-filename">{document.filename}</span>
                          </span>
                          <span className="library-history-type">pdf</span>
                          <span className="library-history-date">{formatLibraryDate(documentHistoryTimestamp(document))}</span>
                          <span className="library-history-progress">
                            <span>{progress}%</span>
                            <span className="library-history-progress-track" aria-hidden="true">
                              <span style={{ width: `${progress}%` }} />
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
        )}
      </section>

      {addDocumentDialogOpen && (
        <div
          className="add-document-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setAddDocumentDialogOpen(false);
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setIsDragging(false);
          }}
          onDrop={handleAddDocumentDrop}
        >
          <section
            className={`add-document-dialog ${isDragging ? "dragging" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label="Dokument hinzufügen"
          >
            <div className="add-document-dialog-header">
              <div>
                <h2>Dokument hinzufügen</h2>
                <p>PDF auswählen oder hier hineinziehen.</p>
              </div>
              <button
                type="button"
                className="add-document-dialog-close"
                onClick={() => setAddDocumentDialogOpen(false)}
                aria-label="Dialog schließen"
              >
                ×
              </button>
            </div>

            <label className="add-document-dropzone">
              <span className="add-document-dropzone-icon">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 15V4M8 8l4-4 4 4" />
                  <path d="M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13" />
                </svg>
              </span>
              <strong>PDF auswählen</strong>
              <span>oder Datei per Drag & Drop hinzufügen</span>
              <input type="file" accept="application/pdf,.pdf" onChange={handleFileInput} />
            </label>
          </section>
        </div>
      )}

      {readerDialog && (
        <div className="reader-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setReaderDialog(null); }}>
          <section className={`reader-dialog ${readerDialog === "skip-content" ? "skip-content-dialog" : ""}`} role="dialog" aria-modal="true">
            <div className="reader-dialog-header">
              <h2>
                {readerDialog === "highlights" && "Hervorhebungen & Notizen"}
                {readerDialog === "bookmarks" && "Lesezeichen"}
                {readerDialog === "skip-content" && "Inhalte automatisch überspringen"}
                {readerDialog === "rename" && "Datei umbenennen"}
              </h2>
              <button type="button" className="reader-dialog-close" onClick={() => setReaderDialog(null)}>×</button>
            </div>

            {readerDialog === "highlights" && (
              textHighlights.length === 0 ? (
                <div className="dialog-empty-state">
                  <div className="dialog-empty-icon">✎</div>
                  <strong>Noch keine Markierungen oder Notizen.</strong>
                  <span>Ziehe im Dokument über Text und wähle anschließend eine Farbe oder füge eine Notiz hinzu.</span>
                </div>
              ) : (
                <div className="text-highlight-list">
                  {[...textHighlights].sort((a, b) => b.createdAt - a.createdAt).map((highlight) => (
                    <div className="text-highlight-row" key={highlight.id}>
                      <button type="button" className="text-highlight-open" onClick={() => goToTextHighlight(highlight)}>
                        <span className={`text-highlight-swatch mark-${highlight.color}`} />
                        <span className="text-highlight-copy">
                          <strong>{highlight.text}</strong>
                          {highlight.note && <small>{highlight.note}</small>}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="text-highlight-remove"
                        onClick={() => persistTextHighlights(textHighlights.filter((entry) => entry.id !== highlight.id))}
                        aria-label="Markierung entfernen"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )
            )}

            {readerDialog === "bookmarks" && (
              bookmarks.length === 0 ? (
                <div className="dialog-empty-state">
                  <div className="dialog-empty-icon">▱</div>
                  <strong>Sie haben noch keine Lesezeichen.</strong>
                  <span>Drücken Sie ⌘B oder nutzen Sie „Zu Lesezeichen hinzufügen“.</span>
                </div>
              ) : (
                <div className="bookmark-list">
                  {bookmarks.map((bookmark) => (
                    <div className="bookmark-row" key={bookmark.id}>
                      <button type="button" onClick={() => goToBookmark(bookmark.pageNumber)}>
                        <span className="bookmark-icon">▱</span>
                        <span>Seite {bookmark.pageNumber}</span>
                      </button>
                      <button
                        type="button"
                        className="bookmark-remove"
                        onClick={() => persistBookmarks(bookmarks.filter((entry) => entry.id !== bookmark.id))}
                        aria-label={`Lesezeichen Seite ${bookmark.pageNumber} entfernen`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )
            )}

            {readerDialog === "skip-content" && (
              <div className="skip-settings-list">
                {(Object.keys(SKIP_CATEGORY_LABELS) as SkipCategory[]).map((category) => {
                  const label = SKIP_CATEGORY_LABELS[category];
                  return (
                    <label className="skip-settings-row" key={category}>
                      <span className="skip-category-icon">
                        {category === "tables"
                          ? "▦"
                          : category === "urls"
                            ? "⌁"
                            : category === "formulas"
                              ? "ƒ"
                              : category === "citations"
                                ? "♙"
                                : category === "parentheses"
                                  ? "( )"
                                  : category === "squareBrackets"
                                    ? "[ ]"
                                    : category === "curlyBraces"
                                      ? "{ }"
                                      : "◫"}
                      </span>
                      <span className="settings-text"><strong>{label.title}</strong><small>{label.subtitle}</small></span>
                      <input type="checkbox" checked={skipContentSettings[category]} onChange={(event) => updateSkipCategory(category, event.target.checked)} />
                      <span className="toggle-switch" />
                    </label>
                  );
                })}
              </div>
            )}

            {readerDialog === "rename" && (
              <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void renameCurrentDocument(); }}>
                <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
                <div className="rename-actions">
                  <button type="button" onClick={() => setReaderDialog(null)}>Abbrechen</button>
                  <button type="submit" className="primary">Umbenennen</button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}

      {draggedDocumentId && documentDragPreviewPosition && (() => {
        const draggedDocument = documents.find(
          (document) => document.documentId === draggedDocumentId,
        );

        if (!draggedDocument) {
          return null;
        }

        const previewSrc = toApiAssetUrl(draggedDocument.previewImageUrl);

        return (
          <div
            className="document-drag-preview"
            style={{
              left: `${documentDragPreviewPosition.x - documentDragPreviewMetrics.offsetX}px`,
              top: `${documentDragPreviewPosition.y - documentDragPreviewMetrics.offsetY}px`,
              width: `${documentDragPreviewMetrics.width}px`,
            }}
            aria-hidden="true"
          >
            <span className="document-drag-preview-image-shell">
              {previewSrc ? (
                <img
                  className="document-drag-preview-image"
                  src={previewSrc}
                  alt=""
                  draggable={false}
                />
              ) : (
                <span className="document-drag-preview-file-icon">PDF</span>
              )}
            </span>

            <span className="document-drag-preview-filename">
              {draggedDocument.filename}
            </span>
          </div>
        );
      })()}

      {selectionDraft && selectionMenuPosition && (
        <div
          className={`text-selection-toolbar ${selectionNoteOpen ? "note-open" : ""} ${selectionCopied ? "copy-confirmed" : ""}`}
          style={{ left: `${selectionMenuPosition.left}px`, top: `${selectionMenuPosition.top}px` }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {selectionCopied ? (
            <div className="selection-copy-confirmation" role="status" aria-live="polite">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="4.5" y="7.5" width="11" height="11" rx="1.8" />
                <rect x="8.5" y="3.5" width="11" height="11" rx="1.8" />
              </svg>
              <span>Kopiert</span>
            </div>
          ) : !selectionNoteOpen ? (
            <>
              <div className="selection-color-row" aria-label="Markierungsfarbe">
                {(["yellow", "green", "pink", "purple", "blue"] as TextMarkColor[]).map((color) => (
                  <button
                    type="button"
                    className={`selection-color-dot ${color}`}
                    key={color}
                    aria-label={`Text ${color} markieren`}
                    onClick={() => addSelectionHighlight(color)}
                  />
                ))}
              </div>
              <div className="selection-toolbar-divider" />
              <button type="button" className="selection-toolbar-action" onClick={() => void copySelectionText()}>
                <span className="selection-toolbar-icon selection-copy-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <rect x="4.5" y="7.5" width="11" height="11" rx="1.8" />
                    <rect x="8.5" y="3.5" width="11" height="11" rx="1.8" />
                  </svg>
                </span>
                <span>Kopieren</span>
              </button>
              <button
                type="button"
                className="selection-toolbar-action"
                onClick={() => {
                  setSelectionNoteColor("yellow");
                  setSelectionNoteColorOpen(false);
                  setSelectionNoteOpen(true);
                }}
              >
                <span className="selection-toolbar-icon">✎</span>
                <span>Notiz hinzufügen</span>
              </button>
            </>
          ) : (
            <div className="selection-note-editor selection-note-editor-dropdown">
              <div className="selection-note-spechify-header">
                <strong>{formatSelectionNoteDate()}</strong>

                <div className="selection-note-header-actions">
                  <div className="selection-note-color-control">
                    <button
                      type="button"
                      className={`selection-note-color-trigger ${selectionNoteColorOpen ? "open" : ""}`}
                      onClick={() => setSelectionNoteColorOpen((open) => !open)}
                      aria-label="Notizfarbe auswählen"
                      aria-expanded={selectionNoteColorOpen}
                    >
                      <span className={`selection-note-trigger-dot ${selectionNoteColor}`} />
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d={selectionNoteColorOpen ? "M7 14l5-5 5 5" : "M7 10l5 5 5-5"} />
                      </svg>
                    </button>

                    {selectionNoteColorOpen && (
                      <div className="selection-note-color-dropdown" role="menu" aria-label="Notizfarbe">
                        {(["yellow", "green", "pink", "purple", "blue"] as TextMarkColor[]).map((color) => (
                          <button
                            type="button"
                            className={`selection-note-dropdown-color ${color} ${selectionNoteColor === color ? "active" : ""}`}
                            key={color}
                            onClick={() => {
                              setSelectionNoteColor(color);
                              setSelectionNoteColorOpen(false);
                            }}
                            aria-label={`Notizfarbe ${color}`}
                            aria-pressed={selectionNoteColor === color}
                            role="menuitemradio"
                          >
                            {selectionNoteColor === color && (
                              <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M6.5 12.5l3.4 3.4 7.6-8" />
                              </svg>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    className="selection-note-close"
                    onClick={() => {
                      setSelectionNoteOpen(false);
                      setSelectionNoteText("");
                      setSelectionNoteColor("yellow");
                      setSelectionNoteColorOpen(false);
                    }}
                    aria-label="Notiz schließen"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="selection-note-textarea-wrap">
                <textarea
                  autoFocus
                  value={selectionNoteText}
                  onChange={(event) => setSelectionNoteText(event.target.value)}
                  placeholder="Text eingeben..."
                />
              </div>

              <div className="selection-note-actions">
                <button
                  type="button"
                  onClick={() => {
                    setSelectionNoteOpen(false);
                    setSelectionNoteText("");
                    setSelectionNoteColor("yellow");
                    setSelectionNoteColorOpen(false);
                  }}
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!selectionNoteText.trim()}
                  onClick={saveSelectionNote}
                >
                  Fertig
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {documentData && chunks.length > 0 && (
        playerVisible ? (
          <PlayerBar
            isPlaying={isPlaying}
            isLoadingAudio={isLoadingAudio}
            playbackError={playbackError}
            hasVoice={hasVoice}
            chunkCount={chunks.length}
            currentGlobalSeconds={currentGlobalSeconds}
            estimatedTotalSeconds={estimatedTotalSeconds}
            playbackRate={playbackRate}
            volume={volume}
            voices={voices}
            voiceVariants={voiceVariants}
            selectedVoiceId={selectedVoiceId}
            openVoicePickerOnMount={!hasVoice}
            autoScrollEnabled={autoScrollEnabled}
            onPlayPause={() => {
              void handlePlayPause();
            }}
            onSeekGlobalTime={seekToGlobalTime}
            onPlaybackRateChange={handlePlaybackRateChange}
            onVolumeChange={setVolume}
            onVoiceChange={handleVoiceChange}
            onVoiceDownload={downloadVoice}
            onVoiceDownloadPause={pauseVoiceDownload}
            onVoiceDownloadResume={resumeVoiceDownload}
            onVoiceDownloadCancel={cancelVoiceDownload}
            onAutoScrollChange={handleAutoScrollChange}
            onRetryPlayback={() => {
              setPlaybackError(null);
              void playChunk(
                activeChunkIndexRef.current,
                currentChunkLocalSecondsRef.current,
              );
            }}
            onDismissPlaybackError={() => setPlaybackError(null)}
            onClose={handleClosePlayer}
          />
        ) : (
          <button
            className="listen-mode-button"
            type="button"
            onClick={handleStartListening}
            disabled={isLoadingAudio}
            aria-label={hasVoice ? "Dokument anhören" : "Stimme auswählen und herunterladen"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8.25 6.1c0-1.03 1.12-1.67 2.02-1.15l8.25 4.78c.89.52.89 1.8 0 2.32l-8.25 4.78c-.9.52-2.02-.12-2.02-1.15V6.1Z" fill="currentColor" />
            </svg>
            <span>Anhören</span>
          </button>
        )
      )}
    </main>
  );
}

export default App;