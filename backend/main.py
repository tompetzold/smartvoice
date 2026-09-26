import hashlib
import json
import logging
import os
import re
import shutil
import statistics
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fitz
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import Response

from tts_engine import TtsCancelledError, TtsEngine
from tts_text import normalize_german_tts_text


BASE_DIR = Path(__file__).resolve().parent

_data_dir_override = os.environ.get("SMARTVOICE_DATA_DIR")

if _data_dir_override:
    DATA_DIR = Path(_data_dir_override).expanduser().resolve()
else:
    DATA_DIR = BASE_DIR / "data"

UPLOAD_DIR = DATA_DIR / "uploads"
DOCUMENTS_DIR = DATA_DIR / "documents"
PIPER_VOICES_DIR = DATA_DIR / "piper_voices"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
PIPER_VOICES_DIR.mkdir(parents=True, exist_ok=True)

RENDER_ZOOM = 2.0
TARGET_CHUNK_CHARS = 1100
HARD_MAX_CHUNK_CHARS = 1600
WORDS_PER_MINUTE_ESTIMATE = 165.0
CHUNKING_VERSION = 6
PREVIEW_TARGET_WIDTH = 180

TTS_ENGINE = TtsEngine(
    documents_dir=DOCUMENTS_DIR,
    piper_voices_dir=PIPER_VOICES_DIR,
    project_root=BASE_DIR.parent,
)

app = FastAPI(title="SmartVoice Backend")
LOGGER = logging.getLogger("uvicorn.error")


class _HideVoiceDownloadPolling(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return not (
            '"GET /api/voices/' in message
            and '/download HTTP/' in message
        )


logging.getLogger("uvicorn.access").addFilter(_HideVoiceDownloadPolling())

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/documents", StaticFiles(directory=str(DOCUMENTS_DIR)), name="documents")


ABBREVIATIONS = {
    "z.",
    "b.",
    "z.b.",
    "bzw.",
    "ca.",
    "vgl.",
    "dr.",
    "prof.",
    "nr.",
    "abb.",
    "tab.",
    "abs.",
    "s.",
    "u.",
    "a.",
    "d.",
    "h.",
    "i.",
    "e.",
    "ggf.",
    "inkl.",
    "max.",
    "min.",
    "kap.",
    "m.sc.",
    "b.sc.",
    "ph.d.",
}


def log(message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[SmartVoice {timestamp}] {message}", flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_filename(filename: str) -> str:
    cleaned = filename.strip().replace("\\", "_").replace("/", "_")
    return cleaned if cleaned else "document.pdf"


def safe_stem(filename: str) -> str:
    stem = Path(filename).stem.strip()
    cleaned = "".join(char if char.isalnum() or char in ("-", "_") else "_" for char in stem)
    cleaned = "_".join(part for part in cleaned.split("_") if part)
    return cleaned if cleaned else "document"


def safe_id(value: str) -> str:
    cleaned = "".join(char if char.isalnum() or char in ("-", "_", ".") else "_" for char in value.strip())
    cleaned = cleaned.strip("._-")
    return cleaned if cleaned else "default"


def hash_file(path: Path) -> str:
    sha256 = hashlib.sha256()

    with open(path, "rb") as file:
        while True:
            chunk = file.read(1024 * 1024)
            if not chunk:
                break
            sha256.update(chunk)

    return sha256.hexdigest()[:16]


METADATA_READ_RETRIES = 4
METADATA_READ_RETRY_DELAY_SECONDS = 0.025

_METADATA_LOCKS_GUARD = threading.Lock()
_METADATA_LOCKS: dict[str, threading.RLock] = {}


def metadata_path(document_id: str) -> Path:
    return DOCUMENTS_DIR / document_id / "metadata.json"


def metadata_lock(document_id: str) -> threading.RLock:
    with _METADATA_LOCKS_GUARD:
        lock = _METADATA_LOCKS.get(document_id)
        if lock is None:
            lock = threading.RLock()
            _METADATA_LOCKS[document_id] = lock
        return lock


def read_metadata(document_id: str) -> dict[str, Any]:
    path = metadata_path(document_id)

    if not path.exists():
        raise FileNotFoundError(f"Metadaten fehlen für Dokument: {document_id}")

    last_decode_error: json.JSONDecodeError | None = None

    for attempt in range(METADATA_READ_RETRIES):
        try:
            with open(path, "r", encoding="utf-8") as file:
                metadata = json.load(file)

            if not isinstance(metadata, dict):
                raise ValueError(
                    f"Ungültige Metadaten für Dokument {document_id}: "
                    "JSON-Wurzel muss ein Objekt sein."
                )

            return metadata
        except json.JSONDecodeError as error:
            last_decode_error = error

            if attempt >= METADATA_READ_RETRIES - 1:
                break

            time.sleep(
                METADATA_READ_RETRY_DELAY_SECONDS * (attempt + 1)
            )

    assert last_decode_error is not None
    raise RuntimeError(
        f"Metadaten für Dokument {document_id} konnten nach "
        f"{METADATA_READ_RETRIES} Leseversuchen nicht vollständig gelesen werden."
    ) from last_decode_error


def write_metadata(document_id: str, metadata: dict[str, Any]) -> None:
    path = metadata_path(document_id)
    path.parent.mkdir(parents=True, exist_ok=True)

    serialized = json.dumps(
        metadata,
        ensure_ascii=False,
        indent=2,
    ).encode("utf-8")

    lock = metadata_lock(document_id)

    with lock:
        temp_fd, temp_name = tempfile.mkstemp(
            prefix=".metadata-",
            suffix=".tmp",
            dir=str(path.parent),
        )
        temp_path = Path(temp_name)

        try:
            with os.fdopen(temp_fd, "wb") as file:
                file.write(serialized)
                file.flush()
                os.fsync(file.fileno())

            os.replace(temp_path, path)
        finally:
            if temp_path.exists():
                temp_path.unlink()


def preview_path(document_id: str) -> Path:
    return DOCUMENTS_DIR / document_id / "preview.png"


def preview_url(document_id: str) -> str:
    return f"/documents/{document_id}/preview.png"


def render_pdf_preview(page: fitz.Page, target_path: Path) -> tuple[int, int]:
    rect = page.rect
    page_width = max(1.0, float(rect.width))
    scale = PREVIEW_TARGET_WIDTH / page_width
    scale = max(0.18, min(scale, 1.35))

    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    pixmap.save(str(target_path))

    return int(pixmap.width), int(pixmap.height)


def ensure_document_preview(document_id: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    effective_metadata = metadata or read_metadata(document_id)
    source_pdf = DOCUMENTS_DIR / document_id / "source.pdf"
    target_path = preview_path(document_id)
    target_url = preview_url(document_id)

    if target_path.exists():
        if effective_metadata.get("previewImageUrl") != target_url:
            effective_metadata["previewImageUrl"] = target_url
            write_metadata(document_id, effective_metadata)
        return effective_metadata

    if not source_pdf.exists():
        return effective_metadata

    lock = metadata_lock(document_id)

    with lock:
        effective_metadata = read_metadata(document_id)

        if target_path.exists():
            if effective_metadata.get("previewImageUrl") != target_url:
                effective_metadata["previewImageUrl"] = target_url
                write_metadata(document_id, effective_metadata)
            return effective_metadata

        document = fitz.open(str(source_pdf))
        try:
            if len(document) == 0:
                return effective_metadata

            width, height = render_pdf_preview(document[0], target_path)
        finally:
            document.close()

        effective_metadata["previewImageUrl"] = target_url
        effective_metadata["previewWidth"] = width
        effective_metadata["previewHeight"] = height
        effective_metadata["previewGeneratedAt"] = now_iso()
        write_metadata(document_id, effective_metadata)
        return effective_metadata


HIGHLIGHT_COLORS: dict[str, tuple[float, float, float]] = {
    "yellow": (1.0, 0.86, 0.20),
    "green": (0.32, 0.82, 0.46),
    "pink": (0.98, 0.42, 0.70),
    "purple": (0.62, 0.46, 0.94),
    "blue": (0.34, 0.62, 0.96),
}


def annotation_rects_for_word_ids(
    words_by_id: dict[str, dict[str, Any]],
    word_ids: list[str],
) -> list[tuple[int, fitz.Rect]]:
    grouped: dict[tuple[int, int, int], list[dict[str, Any]]] = {}

    for word_id in word_ids:
        word = words_by_id.get(word_id)
        if word is None:
            continue

        page_number = int(word.get("pageNumber", 0))
        block_number = int(word.get("blockNumber", 0))
        line_number = int(word.get("lineNumber", 0))
        if page_number <= 0:
            continue

        grouped.setdefault((page_number, block_number, line_number), []).append(word)

    result: list[tuple[int, fitz.Rect]] = []
    for (page_number, _, _), line_words in grouped.items():
        if not line_words:
            continue

        x0 = min(float(word.get("x0", 0.0)) for word in line_words)
        y0 = min(float(word.get("y0", 0.0)) for word in line_words)
        x1 = max(float(word.get("x1", 0.0)) for word in line_words)
        y1 = max(float(word.get("y1", 0.0)) for word in line_words)

        if x1 <= x0 or y1 <= y0:
            continue

        result.append((page_number, fitz.Rect(x0, y0, x1, y1)))

    result.sort(key=lambda item: (item[0], item[1].y0, item[1].x0))
    return result


def export_pdf_with_annotations(
    document_id: str,
    metadata: dict[str, Any],
    highlights: list[dict[str, Any]],
) -> bytes:
    source_pdf = DOCUMENTS_DIR / document_id / "source.pdf"
    if not source_pdf.exists():
        raise FileNotFoundError(f"PDF-Datei fehlt für Dokument: {document_id}")

    words = metadata.get("words", [])
    words_by_id = {str(word.get("id", "")): word for word in words if word.get("id")}
    document = fitz.open(str(source_pdf))

    try:
        for highlight in highlights:
            raw_word_ids = highlight.get("wordIds", [])
            if not isinstance(raw_word_ids, list):
                continue

            word_ids = [str(word_id) for word_id in raw_word_ids]
            rects = annotation_rects_for_word_ids(words_by_id, word_ids)
            if not rects:
                continue

            color_name = str(highlight.get("color", "yellow"))
            color = HIGHLIGHT_COLORS.get(color_name, HIGHLIGHT_COLORS["yellow"])
            note = str(highlight.get("note", "")).strip()
            note_attached = False

            for page_number, rect in rects:
                page_index = page_number - 1
                if page_index < 0 or page_index >= len(document):
                    continue

                page = document[page_index]
                annotation = page.add_highlight_annot(rect)
                annotation.set_colors(stroke=color)
                annotation.set_opacity(0.38)

                if note and not note_attached:
                    annotation.set_info(
                        title="SmartVoice",
                        subject="Hervorhebung & Notiz",
                        content=note,
                    )
                    note_attached = True

                annotation.update()

        return document.tobytes(garbage=4, deflate=True)
    finally:
        document.close()


def normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def clean_token(token: str) -> str:
    return token.strip().strip('"“”„»«()[]{}').lower()


def is_abbreviation_context(words: list[str]) -> bool:
    if not words:
        return False

    last = clean_token(words[-1])

    if last in ABBREVIATIONS:
        return True

    if len(words) >= 2:
        tail_2 = clean_token(words[-2]) + clean_token(words[-1])
        tail_2_spaced = f"{clean_token(words[-2])} {clean_token(words[-1])}"

        if tail_2 in ABBREVIATIONS or tail_2_spaced in ABBREVIATIONS:
            return True

    if len(words) >= 3:
        tail_3 = clean_token(words[-3]) + clean_token(words[-2]) + clean_token(words[-1])
        tail_3_spaced = f"{clean_token(words[-3])} {clean_token(words[-2])} {clean_token(words[-1])}"

        if tail_3 in ABBREVIATIONS or tail_3_spaced in ABBREVIATIONS:
            return True

    return False


def is_sentence_end(current_words: list[dict[str, Any]]) -> bool:
    if not current_words:
        return False

    text_words = [word["text"] for word in current_words]
    last = text_words[-1]
    cleaned = clean_token(last)

    if not re.search(r'[.!?]["“”„»«)\]]*$', last):
        return False

    if is_abbreviation_context(text_words):
        return False

    if re.fullmatch(r"\d+\.", cleaned) and len(current_words) <= 3:
        return False

    if re.fullmatch(r"\d+(\.\d+)+\.?", cleaned) and len(current_words) <= 3:
        return False

    if re.fullmatch(r"[a-zäöüß]\.", cleaned):
        return False

    if cleaned.endswith(".pdf"):
        return False

    return True


def is_probably_page_number(text: str) -> bool:
    value = normalize_spaces(text)

    if re.fullmatch(r"\d+", value):
        return True

    if re.fullmatch(r"-\s*\d+\s*-", value):
        return True

    if re.fullmatch(r"[ivxlcdm]+", value.lower()):
        return True

    return False


def is_probably_dot_leader(text: str) -> bool:
    value = normalize_spaces(text)

    if not value:
        return False

    if value == ".":
        return True

    if all(char == "." or char.isspace() for char in value):
        return True

    return False


def should_skip_line(line: dict[str, Any], page_height: float) -> bool:
    text = normalize_spaces(line["text"])

    if not text:
        return True

    if is_probably_dot_leader(text):
        return True

    return False


def page_line_styles(page: fitz.Page) -> dict[tuple[int, int], dict[str, Any]]:
    styles: dict[tuple[int, int], dict[str, Any]] = {}

    try:
        page_dict = page.get_text("dict")
    except Exception:
        return styles

    for block_index, block in enumerate(page_dict.get("blocks", [])):
        if int(block.get("type", 0)) != 0:
            continue

        for line_index, line in enumerate(block.get("lines", [])):
            spans = line.get("spans", [])
            if not spans:
                continue

            sizes = [float(span.get("size", 0.0)) for span in spans if float(span.get("size", 0.0)) > 0]
            fonts = [str(span.get("font", "")) for span in spans]
            styles[(block_index, line_index)] = {
                "fontSize": max(sizes) if sizes else 0.0,
                "bold": any("bold" in font.lower() or "semibold" in font.lower() for font in fonts),
            }

    return styles


def page_table_rects(page: fitz.Page) -> list[tuple[float, float, float, float]]:
    rects: list[tuple[float, float, float, float]] = []

    try:
        finder = page.find_tables()
        for table in getattr(finder, "tables", []):
            bbox = getattr(table, "bbox", None)
            if bbox and len(bbox) >= 4:
                rects.append((float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])))
    except Exception:
        pass

    return rects


def rect_center_inside(
    line: dict[str, Any],
    rects: list[tuple[float, float, float, float]],
) -> bool:
    cx = (float(line["x0"]) + float(line["x1"])) / 2
    cy = (float(line["y0"]) + float(line["y1"])) / 2

    return any(x0 <= cx <= x1 and y0 <= cy <= y1 for x0, y0, x1, y1 in rects)


def is_formula_like(text: str) -> bool:
    value = normalize_spaces(text)
    if len(value) < 3:
        return False

    math_chars = re.findall(r"[=+×÷±≤≥≈≠∑√∞∫∆λμσπθ^{}\\]", value)
    operator_ratio = len(math_chars) / max(1, len(value))

    if operator_ratio >= 0.08 and re.search(r"[A-Za-zΑ-ω0-9]", value):
        return True

    if re.search(r"\b[A-Za-z]\s*=\s*[^,.;]{1,80}$", value):
        return True

    return False


def is_reference_entry_like(text: str) -> bool:
    value = normalize_spaces(text)
    if len(value) < 8 or not re.search(r"\b(?:18|19|20)\d{2}[a-z]?\b", value):
        return False

    if re.match(
        r"^[A-ZÄÖÜ][A-Za-zÄÖÜäöüßÀ-ÿ'’\-]+,\s*(?:[A-ZÄÖÜ](?:\.|[A-Za-zÄÖÜäöüßÀ-ÿ'’\-]+))",
        value,
    ):
        return True

    if re.match(
        r"^[A-ZÄÖÜ][A-Za-zÄÖÜäöüßÀ-ÿ'’\-]+(?:\s+(?:&|und)\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüßÀ-ÿ'’\-]+)?"
        r"\s*\((?:18|19|20)\d{2}[a-z]?\)",
        value,
    ):
        return True

    return False


def is_citation_like(text: str) -> bool:
    value = normalize_spaces(text)
    if not value:
        return False

    if is_reference_entry_like(value):
        return True

    if re.fullmatch(
        r"\(?(?:vgl\.\s*)?[A-ZÄÖÜ][^()]{0,180}?,\s*(?:18|19|20)\d{2}[a-z]?"
        r"(?:,\s*(?:(?:S|Abs|Kap|Rn)\.?\s*)?[0-9IVXLC]+(?:[-–][0-9IVXLC]+)?)?"
        r"(?:;\s*[^()]{1,120})?\)?[.,;:]?",
        value,
        flags=re.IGNORECASE,
    ):
        return True

    if re.fullmatch(r"\[[0-9,;\s\-–]+\][.,;:]?", value):
        return True

    if re.match(
        r"^(quelle|quellen|source|sources|literatur|literaturverzeichnis|reference|references)\s*:?",
        value,
        flags=re.IGNORECASE,
    ):
        return True

    return False


URL_PATTERN = re.compile(
    r"(?:https?://|www\.)[^\s<>()\[\]{}]+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b",
    flags=re.IGNORECASE,
)

PLAIN_CITATION_PATTERN = re.compile(
    r"\b(?:vgl\.\s*)?"
    r"[A-ZÄÖÜ][A-Za-zÄÖÜäöüßÀ-ÿ'’\-]+"
    r"(?:[-\s][A-ZÄÖÜ][A-Za-zÄÖÜäöüßÀ-ÿ'’\-]+)*"
    r"(?:\s+(?:et\s+al\.|u\.\s*a\.))?"
    r",\s*(?:18|19|20)\d{2}[a-z]?"
    r"(?:,\s*(?:(?:S|Abs|Kap|Rn)\.?\s*)?[0-9IVXLC]+(?:[-–][0-9IVXLC]+)?)?",
    flags=re.IGNORECASE,
)

NARRATIVE_CITATION_PATTERN = re.compile(
    r"\b"
    r"[A-ZÄÖÜ][A-Za-zÄÖÜäöüßÀ-ÿ'’\-]+"
    r"(?:[-\s][A-ZÄÖÜ][A-Za-zÄÖÜäöüßÀ-ÿ'’\-]+)*"
    r"(?:\s+(?:et\s+al\.|u\.\s*a\.))?"
    r"\s*\(\s*(?:18|19|20)\d{2}[a-z]?"
    r"(?:,\s*(?:(?:S|Abs|Kap|Rn)\.?\s*)?[0-9IVXLC]+(?:[-–][0-9IVXLC]+)?)?"
    r"\s*\)",
    flags=re.IGNORECASE,
)


def url_coverage(text: str) -> float:
    value = normalize_spaces(text)
    if not value:
        return 0.0

    matches = list(URL_PATTERN.finditer(value))
    return sum(len(match.group(0)) for match in matches) / max(1, len(value))


def word_character_spans(words: list[dict[str, Any]]) -> tuple[str, list[tuple[int, int, dict[str, Any]]]]:
    parts: list[str] = []
    spans: list[tuple[int, int, dict[str, Any]]] = []
    cursor = 0

    for word in words:
        value = str(word.get("text", ""))
        if not value:
            continue

        if parts:
            parts.append(" ")
            cursor += 1

        start = cursor
        parts.append(value)
        cursor += len(value)
        spans.append((start, cursor, word))

    return "".join(parts), spans


def balanced_delimiter_spans(text: str, opener: str, closer: str) -> list[tuple[int, int]]:
    stack: list[int] = []
    spans: list[tuple[int, int]] = []

    for index, char in enumerate(text):
        if char == opener:
            stack.append(index)
        elif char == closer and stack:
            start = stack.pop()
            spans.append((start, index + 1))

    spans.sort()
    return spans


def ranges_overlap(left_start: int, left_end: int, right_start: int, right_end: int) -> bool:
    return left_start < right_end and right_start < left_end


def add_category_to_words_in_ranges(
    word_spans: list[tuple[int, int, dict[str, Any]]],
    ranges: list[tuple[int, int]],
    category: str,
) -> None:
    if not ranges:
        return

    for word_start, word_end, word in word_spans:
        if any(ranges_overlap(word_start, word_end, range_start, range_end) for range_start, range_end in ranges):
            categories = set(str(value) for value in word.get("skipCategories", []))
            categories.add(category)
            word["skipCategories"] = sorted(categories)


def parenthetical_is_citation(text: str) -> bool:
    value = normalize_spaces(text.strip("() "))
    if not value:
        return False

    if re.search(r"\b(?:ebd\.|ibid\.|a\.\s*a\.\s*o\.)", value, flags=re.IGNORECASE):
        return True

    has_year = bool(re.search(r"\b(?:18|19|20)\d{2}[a-z]?\b", value))
    has_no_year_marker = bool(re.search(r"\bo\.\s*j\.\b", value, flags=re.IGNORECASE))
    if not (has_year or has_no_year_marker):
        return False

    if re.search(r"\b(?:S|Abs|Kap|Rn)\.?\s*\d+", value, flags=re.IGNORECASE):
        return True

    if re.search(r"\bet\s+al\.\b", value, flags=re.IGNORECASE):
        return True

    if re.search(r"[A-ZÄÖÜ][A-Za-zÄÖÜäöüßÀ-ÿ'’\-]+(?:\s+(?:&|und)\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüßÀ-ÿ'’\-]+)?\s*,", value):
        return True

    if re.search(r";", value) and re.search(r"[A-Za-zÄÖÜäöüß]", value):
        return True

    return False


def apply_inline_skip_categories_to_words(words: list[dict[str, Any]]) -> None:
    if not words:
        return

    text, word_spans = word_character_spans(words)
    if not text:
        return

    parentheses_ranges = balanced_delimiter_spans(text, "(", ")")
    square_ranges = balanced_delimiter_spans(text, "[", "]")
    curly_ranges = balanced_delimiter_spans(text, "{", "}")

    add_category_to_words_in_ranges(word_spans, parentheses_ranges, "parentheses")
    add_category_to_words_in_ranges(word_spans, square_ranges, "squareBrackets")
    add_category_to_words_in_ranges(word_spans, curly_ranges, "curlyBraces")

    url_ranges = [(match.start(), match.end()) for match in URL_PATTERN.finditer(text)]
    add_category_to_words_in_ranges(word_spans, url_ranges, "urls")

    citation_ranges: list[tuple[int, int]] = []

    for range_start, range_end in parentheses_ranges:
        candidate = text[range_start:range_end]
        if parenthetical_is_citation(candidate):
            citation_ranges.append((range_start, range_end))

    for match in NARRATIVE_CITATION_PATTERN.finditer(text):
        citation_ranges.append((match.start(), match.end()))

    for match in PLAIN_CITATION_PATTERN.finditer(text):
        citation_ranges.append((match.start(), match.end()))

    for range_start, range_end in square_ranges:
        candidate = normalize_spaces(text[range_start:range_end])
        if re.fullmatch(r"\[\s*(?:\d+(?:\s*[,;\-–]\s*\d+)*)\s*\][.,;:]?", candidate):
            citation_ranges.append((range_start, range_end))
        elif re.search(r"\b(?:18|19|20)\d{2}[a-z]?\b", candidate):
            citation_ranges.append((range_start, range_end))

    add_category_to_words_in_ranges(word_spans, citation_ranges, "citations")


def apply_inline_skip_categories(line: dict[str, Any]) -> None:
    apply_inline_skip_categories_to_words(line.get("words", []))


def recurring_page_furniture_keys(
    lines: list[dict[str, Any]],
    page_count: int,
    page_heights: dict[int, float],
) -> set[str]:
    candidates: dict[str, set[int]] = {}

    for line in lines:
        page_number = int(line["pageNumber"])
        page_height = page_heights.get(page_number, 0.0)
        if page_height <= 0:
            continue

        y_center = (float(line["y0"]) + float(line["y1"])) / 2
        text = normalize_spaces(str(line.get("text", "")))
        if not text or len(text) > 180:
            continue

        if not (y_center <= page_height * 0.12 or y_center >= page_height * 0.88):
            continue

        key = re.sub(r"\d+", "#", text.lower())
        key = re.sub(r"\s+", " ", key).strip(" -–—|·")
        if len(key) < 3:
            continue

        candidates.setdefault(key, set()).add(page_number)

    minimum_pages = 2 if page_count <= 8 else max(3, int(round(page_count * 0.18)))
    return {key for key, pages in candidates.items() if len(pages) >= minimum_pages}


def apply_recurring_page_furniture(
    lines: list[dict[str, Any]],
    page_count: int,
    page_heights: dict[int, float],
) -> None:
    recurring_keys = recurring_page_furniture_keys(lines, page_count, page_heights)
    if not recurring_keys:
        return

    for line in lines:
        page_number = int(line["pageNumber"])
        page_height = page_heights.get(page_number, 0.0)
        if page_height <= 0:
            continue

        y_center = (float(line["y0"]) + float(line["y1"])) / 2
        if not (y_center <= page_height * 0.12 or y_center >= page_height * 0.88):
            continue

        value = normalize_spaces(str(line.get("text", "")))
        key = re.sub(r"\d+", "#", value.lower())
        key = re.sub(r"\s+", " ", key).strip(" -–—|·")
        if key not in recurring_keys:
            continue

        line_categories = set(str(category) for category in line.get("skipCategories", []))
        line_categories.add("footers")
        line["skipCategories"] = sorted(line_categories)

        for word in line.get("words", []):
            categories = set(str(category) for category in word.get("skipCategories", []))
            categories.add("footers")
            word["skipCategories"] = sorted(categories)


def classify_line_content(
    line: dict[str, Any],
    *,
    page_width: float,
    page_height: float,
    median_line_height: float,
    median_font_size: float,
    table_rects: list[tuple[float, float, float, float]],
) -> list[str]:
    text = normalize_spaces(str(line.get("text", "")))
    if not text:
        return []

    categories: set[str] = set()
    y0 = float(line["y0"])
    y1 = float(line["y1"])
    line_h = max(1.0, y1 - y0)
    y_center = (y0 + y1) / 2
    word_count = len(line.get("words", []))
    font_size = float(line.get("fontSize", 0.0))
    bold = bool(line.get("bold", False))

    if (
        (y_center <= page_height * 0.045 and len(text) <= 140)
        or (y_center >= page_height * 0.94 and len(text) <= 180)
        or (y_center >= page_height * 0.86 and is_probably_page_number(text))
    ):
        categories.add("footers")

    if rect_center_inside(line, table_rects):
        categories.add("tables")

    small_font = median_font_size > 0 and font_size > 0 and font_size <= median_font_size * 0.86
    small_line = line_h <= median_line_height * 0.84
    footnote_marker = bool(
        re.match(
            r"^\s*(?:\d{1,3}|[*†‡])(?:[.)]|\s+)\s*\S+",
            text,
        )
    )
    if y_center >= page_height * 0.66 and (small_font or small_line) and (word_count <= 42 or footnote_marker):
        categories.add("footnotes")

    heading_by_font = median_font_size > 0 and font_size >= median_font_size * 1.17
    heading_by_height = line_h >= median_line_height * 1.16
    short_heading = len(text) <= 180 and word_count <= 24
    numbered_heading = bool(
        re.match(
            r"^\s*(?:\d+(?:\.\d+)*\.?|[IVXLC]+\.)\s+\S+",
            text,
        )
    )

    if short_heading and (
        (heading_by_font and (bold or font_size >= median_font_size * 1.30))
        or (heading_by_height and bold)
        or (numbered_heading and bold)
    ):
        categories.add("headings")

    if is_formula_like(text):
        categories.add("formulas")

    if is_citation_like(text):
        categories.add("citations")

    if url_coverage(text) >= 0.72:
        categories.add("urls")

    return sorted(categories)


def extract_words_and_lines(document: fitz.Document) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    all_words: list[dict[str, Any]] = []
    all_lines: list[dict[str, Any]] = []
    page_heights: dict[int, float] = {}
    global_word_index = 1

    for page_index in range(len(document)):
        page_number = page_index + 1
        page = document[page_index]
        page_width = float(page.rect.width)
        page_height = float(page.rect.height)
        page_heights[page_number] = page_height
        styles = page_line_styles(page)
        table_rects = page_table_rects(page)

        raw_words = page.get_text("words")
        raw_words_sorted = sorted(
            raw_words,
            key=lambda item: (
                int(item[5]),
                int(item[6]),
                int(item[7]),
                float(item[1]),
                float(item[0]),
            ),
        )

        line_map: dict[tuple[int, int], list[dict[str, Any]]] = {}

        for raw_word in raw_words_sorted:
            x0, y0, x1, y1, word_text, block_number, line_number, word_number = raw_word
            clean_text = normalize_spaces(str(word_text))

            if not clean_text:
                continue

            word = {
                "id": f"w_{global_word_index:08d}",
                "pageNumber": page_number,
                "text": clean_text,
                "x0": round(float(x0), 2),
                "y0": round(float(y0), 2),
                "x1": round(float(x1), 2),
                "y1": round(float(y1), 2),
                "blockNumber": int(block_number),
                "lineNumber": int(line_number),
                "wordNumber": int(word_number),
                "skipCategories": [],
            }

            all_words.append(word)
            line_key = (int(block_number), int(line_number))
            line_map.setdefault(line_key, []).append(word)
            global_word_index += 1

        page_lines: list[dict[str, Any]] = []

        for (block_number, line_number), line_words in line_map.items():
            sorted_line_words = sorted(line_words, key=lambda word: (word["x0"], word["wordNumber"]))
            line_text = normalize_spaces(" ".join(word["text"] for word in sorted_line_words))

            if not line_text:
                continue

            style = styles.get((block_number, line_number), {})
            line = {
                "id": f"l_{page_number:04d}_{block_number:04d}_{line_number:04d}",
                "pageNumber": page_number,
                "blockNumber": block_number,
                "lineNumber": line_number,
                "text": line_text,
                "x0": round(min(word["x0"] for word in sorted_line_words), 2),
                "y0": round(min(word["y0"] for word in sorted_line_words), 2),
                "x1": round(max(word["x1"] for word in sorted_line_words), 2),
                "y1": round(max(word["y1"] for word in sorted_line_words), 2),
                "wordIds": [word["id"] for word in sorted_line_words],
                "words": sorted_line_words,
                "fontSize": float(style.get("fontSize", 0.0)),
                "bold": bool(style.get("bold", False)),
                "skipCategories": [],
            }

            if should_skip_line(line, page_height):
                continue

            page_lines.append(line)

        line_heights = [max(1.0, float(line["y1"]) - float(line["y0"])) for line in page_lines]
        font_sizes = [
            float(line.get("fontSize", 0.0))
            for line in page_lines
            if float(line.get("fontSize", 0.0)) > 0
        ]
        median_line_height = statistics.median(line_heights) if line_heights else 10.0
        median_font_size = statistics.median(font_sizes) if font_sizes else 0.0

        for line in page_lines:
            categories = classify_line_content(
                line,
                page_width=page_width,
                page_height=page_height,
                median_line_height=median_line_height,
                median_font_size=median_font_size,
                table_rects=table_rects,
            )
            line["skipCategories"] = categories

            for word in line.get("words", []):
                word["skipCategories"] = list(categories)

            apply_inline_skip_categories(line)
            all_lines.append(line)

    all_lines.sort(
        key=lambda line: (
            line["pageNumber"],
            line["blockNumber"],
            line["lineNumber"],
            line["y0"],
            line["x0"],
        )
    )

    apply_recurring_page_furniture(
        all_lines,
        page_count=len(document),
        page_heights=page_heights,
    )

    return all_words, all_lines


def merge_words_to_line_boxes(words: list[dict[str, Any]]) -> list[list[float]]:
    if not words:
        return []

    grouped: dict[tuple[int, int, int], list[dict[str, Any]]] = {}

    for word in words:
        key = (
            int(word["pageNumber"]),
            int(word["blockNumber"]),
            int(word["lineNumber"]),
        )
        grouped.setdefault(key, []).append(word)

    boxes: list[list[float]] = []

    for _, group_words in grouped.items():
        boxes.append(
            [
                round(min(word["x0"] for word in group_words), 2),
                round(min(word["y0"] for word in group_words), 2),
                round(max(word["x1"] for word in group_words), 2),
                round(max(word["y1"] for word in group_words), 2),
            ]
        )

    boxes.sort(key=lambda box: (box[1], box[0]))
    return boxes



def public_word_data(word: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": word["id"],
        "text": word["text"],
        "pageNumber": int(word["pageNumber"]),
        "x0": float(word["x0"]),
        "y0": float(word["y0"]),
        "x1": float(word["x1"]),
        "y1": float(word["y1"]),
        "blockNumber": int(word["blockNumber"]),
        "lineNumber": int(word["lineNumber"]),
        "wordNumber": int(word["wordNumber"]),
        "skipCategories": list(word.get("skipCategories", [])),
    }


def merge_words_to_line_rects(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not words:
        return []

    grouped: dict[tuple[int, int, int], list[dict[str, Any]]] = {}

    for word in words:
        key = (
            int(word["pageNumber"]),
            int(word["blockNumber"]),
            int(word["lineNumber"]),
        )
        grouped.setdefault(key, []).append(word)

    rects: list[dict[str, Any]] = []

    for (page_number, _, _), group_words in grouped.items():
        rects.append(
            {
                "pageNumber": page_number,
                "x0": round(min(float(word["x0"]) for word in group_words), 2),
                "y0": round(min(float(word["y0"]) for word in group_words), 2),
                "x1": round(max(float(word["x1"]) for word in group_words), 2),
                "y1": round(max(float(word["y1"]) for word in group_words), 2),
            }
        )

    rects.sort(key=lambda rect: (int(rect["pageNumber"]), float(rect["y0"]), float(rect["x0"])))
    return rects


def line_height(line: dict[str, Any]) -> float:
    return max(1.0, float(line["y1"]) - float(line["y0"]))


def line_has_sentence_end(line: dict[str, Any]) -> bool:
    words = line.get("words", [])
    return is_sentence_end(words) if words else False


def is_probable_paragraph_break(previous_line: dict[str, Any], line: dict[str, Any]) -> bool:
    if int(previous_line["pageNumber"]) != int(line["pageNumber"]):
        return False

    previous_height = line_height(previous_line)
    current_height = line_height(line)
    reference_height = max(previous_height, current_height)
    vertical_gap = float(line["y0"]) - float(previous_line["y1"])

    if vertical_gap >= max(6.0, reference_height * 0.72):
        return True

    block_changed = int(previous_line["blockNumber"]) != int(line["blockNumber"])
    if not block_changed:
        return False

    indent_delta = float(line["x0"]) - float(previous_line["x0"])
    if line_has_sentence_end(previous_line) and indent_delta >= max(9.0, reference_height * 0.72):
        return True

    return False


def create_segment(
    segment_index: int,
    words: list[dict[str, Any]],
    paragraph_id: str,
    segment_type: str = "text",
) -> dict[str, Any] | None:
    clean_words = [word for word in words if normalize_spaces(word["text"])]

    if not clean_words:
        return None

    apply_inline_skip_categories_to_words(clean_words)
    text = normalize_spaces(" ".join(word["text"] for word in clean_words))

    if not text:
        return None

    page_numbers = sorted({int(word["pageNumber"]) for word in clean_words})

    category_counts: dict[str, int] = {}
    for word in clean_words:
        for category in word.get("skipCategories", []):
            category_counts[str(category)] = category_counts.get(str(category), 0) + 1

    threshold = max(1, int(len(clean_words) * 0.45))
    skip_categories = sorted(
        category for category, count in category_counts.items() if count >= threshold
    )

    return {
        "id": f"u_{segment_index:06d}",
        "text": text,
        "pageNumber": page_numbers[0],
        "pageNumbers": page_numbers,
        "wordIds": [word["id"] for word in clean_words],
        "words": [public_word_data(word) for word in clean_words],
        "lineBoxes": merge_words_to_line_boxes(clean_words),
        "lineRects": merge_words_to_line_rects(clean_words),
        "type": segment_type,
        "readMode": "tts_original",
        "pauseAfterMs": 180,
        "paragraphId": paragraph_id,
        "paragraphBreakAfter": False,
        "source": "pdf_text",
        "skipCategories": skip_categories,
    }


def build_default_segments(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    segment_index = 1
    paragraph_index = 0
    current_words: list[dict[str, Any]] = []
    current_paragraph_id = ""
    previous_line: dict[str, Any] | None = None

    def start_paragraph(line: dict[str, Any]) -> str:
        nonlocal paragraph_index
        paragraph_index += 1
        return f"p_{paragraph_index:06d}_{int(line['pageNumber']):04d}_{int(line['blockNumber']):04d}"

    def flush_segment() -> None:
        nonlocal current_words
        nonlocal segment_index

        if not current_words or not current_paragraph_id:
            current_words = []
            return

        segment = create_segment(
            segment_index=segment_index,
            words=current_words,
            paragraph_id=current_paragraph_id,
        )
        if segment is not None:
            segments.append(segment)
            segment_index += 1
        current_words = []

    for line in lines:
        line_words = line.get("words", [])
        if not line_words:
            previous_line = line
            continue

        if previous_line is None:
            current_paragraph_id = start_paragraph(line)
        elif is_probable_paragraph_break(previous_line, line) and not current_words:
            current_paragraph_id = start_paragraph(line)

        special_categories = set(line.get("skipCategories", [])) & {
            "headings", "footers", "footnotes", "tables", "formulas", "citations", "urls"
        }

        if special_categories:
            flush_segment()
            if not current_paragraph_id:
                current_paragraph_id = start_paragraph(line)
            current_words.extend(line_words)
            flush_segment()
            previous_line = line
            continue

        for word in line_words:
            current_words.append(word)

            if is_sentence_end(current_words):
                flush_segment()

        previous_line = line

    flush_segment()

    for index, segment in enumerate(segments):
        next_segment = segments[index + 1] if index + 1 < len(segments) else None
        paragraph_ends = next_segment is None or next_segment.get("paragraphId") != segment.get("paragraphId")
        segment["paragraphBreakAfter"] = paragraph_ends
        segment["pauseAfterMs"] = 420 if paragraph_ends else 120

    return segments

def estimate_text_duration_seconds(text: str) -> float:
    words = [part for part in normalize_spaces(text).split(" ") if part]
    word_count = max(1, len(words))
    return max(1.0, word_count / WORDS_PER_MINUTE_ESTIMATE * 60.0)


def _unit_public_data(unit: dict[str, Any]) -> dict[str, Any]:
    return {
        "unitId": unit["id"],
        "text": unit["text"],
        "type": unit.get("type", "text"),
        "source": unit.get("source", "pdf_text"),
        "pageNumber": unit.get("pageNumber"),
        "pageNumbers": unit.get("pageNumbers", []),
        "lineBoxes": unit.get("lineBoxes", []),
        "lineRects": unit.get("lineRects", []),
        "wordIds": unit.get("wordIds", []),
        "words": unit.get("words", []),
        "paragraphId": unit.get("paragraphId"),
        "paragraphBreakAfter": bool(unit.get("paragraphBreakAfter", False)),
        "pauseAfterMs": int(unit.get("pauseAfterMs", 180)),
        "skipCategories": list(unit.get("skipCategories", [])),
    }


def _chunk_text(units: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    previous_paragraph_id: str | None = None

    for unit in units:
        text = normalize_spaces(str(unit.get("text", "")))
        if not text:
            continue

        paragraph_id = str(unit.get("paragraphId") or unit.get("id"))
        if parts and previous_paragraph_id is not None and paragraph_id != previous_paragraph_id:
            parts.append("\n\n")
        elif parts:
            parts.append(" ")

        parts.append(text)
        previous_paragraph_id = paragraph_id

    return "".join(parts).strip()


ALLOWED_SKIP_CATEGORIES = {
    "headings",
    "footers",
    "footnotes",
    "tables",
    "formulas",
    "citations",
    "urls",
    "parentheses",
    "squareBrackets",
    "curlyBraces",
}


def parse_skip_categories(value: str | None) -> set[str]:
    if not value:
        return set()

    return {
        category
        for category in (part.strip() for part in value.split(","))
        if category in ALLOWED_SKIP_CATEGORIES
    }


def word_is_skipped_for_tts(word: dict[str, Any], skip_categories: set[str]) -> bool:
    if not skip_categories:
        return False

    categories = {str(category) for category in word.get("skipCategories", [])}
    return bool(categories & skip_categories)


def cleaned_spoken_text(words: list[dict[str, Any]]) -> str:
    value = normalize_spaces(
        " ".join(str(word.get("text", "")) for word in words if word.get("text"))
    )
    if not value:
        return ""

    value = value.replace("\u00ad", "")
    value = value.replace("\u200b", "")
    value = value.replace("\u200c", "")
    value = value.replace("\u200d", "")
    value = value.replace("\ufeff", "")

    value = re.sub(r"\s+([,.;:!?])", r"\1", value)
    value = re.sub(r"([(\[{])\s+", r"\1", value)
    value = re.sub(r"\s+([)\]}])", r"\1", value)
    value = re.sub(r"\(\s*\)|\[\s*\]|\{\s*\}", " ", value)

    for opening, closing in (("(", ")"), ("[", "]"), ("{", "}")):
        if value.count(opening) > value.count(closing):
            value = value.replace(opening, " ")
        elif value.count(closing) > value.count(opening):
            value = value.replace(closing, " ")

    value = re.sub(r"^[,;:.!?…\\-–—\s]+", "", value)
    value = re.sub(r"\s{2,}", " ", value).strip()

    if value and value[-1] in ",;:-–—":
        value = value[:-1].rstrip() + "."

    return value


def tts_text_is_speakable(value: str) -> bool:
    normalized = normalize_german_tts_text(value)
    return bool(normalized and any(character.isalnum() for character in normalized))


def skipped_chunk_http_exception(chunk_id: str) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "code": "SKIPPED_BY_RULES",
            "chunkId": chunk_id,
            "message": "Dieser Satz enthält nach den aktiven Überspringregeln keinen vorlesbaren Inhalt.",
        },
    )


def filtered_unit_for_tts(unit: dict[str, Any], skip_categories: set[str]) -> dict[str, Any] | None:
    words = [
        word
        for word in unit.get("words", [])
        if not word_is_skipped_for_tts(word, skip_categories)
    ]

    if not words:
        return None

    filtered = dict(unit)
    filtered["words"] = [dict(word) for word in words]
    filtered["wordIds"] = [str(word["id"]) for word in words]
    filtered["text"] = cleaned_spoken_text(words)
    if not tts_text_is_speakable(str(filtered["text"])):
        return None

    filtered["pageNumbers"] = sorted({int(word["pageNumber"]) for word in words})
    filtered["pageNumber"] = int(words[0]["pageNumber"])
    filtered["lineBoxes"] = merge_words_to_line_boxes(words)
    filtered["lineRects"] = merge_words_to_line_rects(words)
    return filtered


def filtered_chunk_for_tts(
    chunk: dict[str, Any],
    skip_categories: set[str],
) -> dict[str, Any] | None:
    if not skip_categories:
        return chunk

    units: list[dict[str, Any]] = []

    for unit in chunk.get("units", []):
        filtered = filtered_unit_for_tts(unit, skip_categories)
        if filtered is not None and normalize_spaces(str(filtered.get("text", ""))):
            units.append(filtered)

    if not units:
        return None

    filtered_chunk = dict(chunk)
    filtered_chunk["units"] = units
    filtered_chunk["unitIds"] = [str(unit["unitId"]) for unit in units]
    filtered_chunk["text"] = _chunk_text(units)
    filtered_chunk["pageNumbers"] = sorted(
        {
            int(page_number)
            for unit in units
            for page_number in unit.get("pageNumbers", [])
        }
    )
    filtered_chunk["pageNumber"] = units[0].get("pageNumber")
    filtered_chunk["charCount"] = len(str(filtered_chunk["text"]))
    filtered_chunk["wordCount"] = sum(len(unit.get("words", [])) for unit in units)
    return filtered_chunk


def _paragraph_groups(units: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    current_group: list[dict[str, Any]] = []
    current_paragraph_id: str | None = None

    for unit in units:
        paragraph_id = str(unit.get("paragraphId") or unit.get("id"))
        if current_group and paragraph_id != current_paragraph_id:
            groups.append(current_group)
            current_group = []

        current_group.append(unit)
        current_paragraph_id = paragraph_id

    if current_group:
        groups.append(current_group)

    return groups


def build_tts_chunks(units: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build exactly one audio chunk per logical sentence.

    This intentionally trades a larger number of small cached files for deterministic
    synchronization: the active TTS chunk and the active highlighted sentence are
    always the same object. A visual PDF line break can therefore never shift the
    sentence highlight into the next sentence, and clicking a sentence always starts
    at the real beginning of that sentence instead of at an estimated offset inside a
    larger paragraph chunk.
    """
    chunks: list[dict[str, Any]] = []

    for unit in units:
        text = normalize_spaces(str(unit.get("text", "")))
        if not text:
            continue

        chunk_index = len(chunks) + 1
        chunk_id = f"c_{chunk_index:06d}"
        page_numbers = sorted(
            {
                int(page_number)
                for page_number in unit.get("pageNumbers", [])
                if page_number is not None
            }
        )

        chunks.append(
            {
                "id": chunk_id,
                "text": text,
                "unitIds": [unit["id"]],
                "units": [_unit_public_data(unit)],
                "pageNumber": unit.get("pageNumber"),
                "pageNumbers": page_numbers,
                "estimatedDuration": round(estimate_text_duration_seconds(text), 3),
                "charCount": len(text),
                "wordCount": len([part for part in re.split(r"\s+", text) if part]),
                "paragraphIds": [str(unit.get("paragraphId") or unit.get("id"))],
                "skipCategories": list(unit.get("skipCategories", [])),
            }
        )

    return chunks


def build_reading_blocks_from_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []

    for index, segment in enumerate(segments, start=1):
        blocks.append(
            {
                "id": f"b_{index:06d}",
                "pageNumber": segment["pageNumber"],
                "blockNumber": index,
                "type": segment["type"],
                "readMode": segment["readMode"],
                "text": segment["text"],
                "lineBoxes": segment["lineBoxes"],
                "wordIds": segment["wordIds"],
            }
        )

    return blocks


def extract_text_data(document: fitz.Document) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    words, lines = extract_words_and_lines(document)
    units = build_default_segments(lines)
    reading_blocks = build_reading_blocks_from_segments(units)
    chunks = build_tts_chunks(units)

    log(f"Textdaten: words={len(words)}, lines={len(lines)}, units={len(units)}, chunks={len(chunks)}")

    return words, units, reading_blocks, chunks


def metadata_needs_chunk_rebuild(metadata: dict[str, Any]) -> bool:
    return (
        metadata.get("chunkingVersion") != CHUNKING_VERSION
        or "chunks" not in metadata
        or not isinstance(metadata.get("chunks"), list)
    )


def ensure_chunks(metadata: dict[str, Any], document_id: str | None = None) -> dict[str, Any]:
    if not metadata_needs_chunk_rebuild(metadata):
        return metadata

    effective_document_id = document_id or str(metadata.get("documentId", ""))
    source_pdf = DOCUMENTS_DIR / effective_document_id / "source.pdf" if effective_document_id else None

    if source_pdf is not None and source_pdf.exists():
        document = fitz.open(str(source_pdf))
        try:
            words, units, reading_blocks, chunks = extract_text_data(document)
        finally:
            document.close()

        metadata["words"] = words
        metadata["sentences"] = units
        metadata["readingUnits"] = units
        metadata["readingBlocks"] = reading_blocks
        metadata["chunks"] = chunks
    else:
        units = metadata.get("sentences", [])
        metadata["chunks"] = build_tts_chunks(units)

    metadata["chunkingVersion"] = CHUNKING_VERSION
    metadata["updatedAt"] = now_iso()
    return metadata


def read_metadata_with_chunks(document_id: str) -> dict[str, Any]:
    metadata = read_metadata(document_id)

    if not metadata_needs_chunk_rebuild(metadata):
        return metadata

    lock = metadata_lock(document_id)

    with lock:
        metadata = read_metadata(document_id)

        if metadata_needs_chunk_rebuild(metadata):
            metadata = ensure_chunks(metadata, document_id)
            write_metadata(document_id, metadata)

        return metadata


def get_chunk_by_id(metadata: dict[str, Any], chunk_id: str) -> dict[str, Any]:
    for chunk in metadata.get("chunks", []):
        if chunk.get("id") == chunk_id:
            return chunk

    raise FileNotFoundError(f"Chunk nicht gefunden: {chunk_id}")

def spoken_word_weight(text: str) -> float:
    value = normalize_spaces(text)
    if not value:
        return 1.0

    lexical = re.sub(r"[^A-Za-zÄÖÜäöüß0-9]", "", value)
    letters = re.sub(r"[^A-Za-zÄÖÜäöüß]", "", lexical)
    digits = re.sub(r"[^0-9]", "", lexical)
    vowel_groups = re.findall(r"[aeiouyäöüAEIOUYÄÖÜ]+", letters)

    # Character length is a better local proxy for German phoneme duration than
    # syllable count alone. Syllables still contribute so long vowel-rich words do
    # not advance the highlight too quickly. Numbers get extra weight because they
    # are usually spoken as full German number words.
    weight = 0.65
    weight += len(letters) * 0.34
    weight += max(1, len(vowel_groups)) * 0.58 if letters else 0.0
    weight += len(digits) * 0.95

    lower = value.lower()
    if lower in {"z.", "b.", "d.", "h.", "s.", "vgl.", "bzw.", "ca."}:
        weight += 0.9

    if re.search(r"[.!?][\"“”„»«)\]]*$", value):
        weight += 1.55
    elif re.search(r"[,;:][\"“”„»«)\]]*$", value):
        weight += 0.72

    return max(0.8, weight)


def build_alignment_timings(
    chunk: dict[str, Any],
    duration: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    units = chunk.get("units", [])
    if not units:
        return [], []

    # CHUNKING_VERSION 4 guarantees one sentence per chunk. Keeping the generic
    # fallback below makes old/debug metadata harmless, but the normal path has an
    # exact sentence boundary: start 0.0, end == real WAV duration.
    if len(units) == 1:
        unit = units[0]
        words = unit.get("words", [])
        unit_timing = {
            **unit,
            "start": 0.0,
            "end": round(duration, 3),
        }

        if not words:
            return [unit_timing], []

        weights = [spoken_word_weight(str(word.get("text", ""))) for word in words]
        total_weight = max(0.0001, sum(weights))
        word_timings: list[dict[str, Any]] = []
        cursor = 0.0

        for index, (word, weight) in enumerate(zip(words, weights)):
            start = cursor
            if index == len(words) - 1:
                end = duration
            else:
                end = min(duration, start + duration * (weight / total_weight))

            word_timings.append(
                {
                    "wordId": word["id"],
                    "unitId": unit["unitId"],
                    "text": word.get("text", ""),
                    "pageNumber": word.get("pageNumber"),
                    "x0": word.get("x0"),
                    "y0": word.get("y0"),
                    "x1": word.get("x1"),
                    "y1": word.get("y1"),
                    "start": round(start, 3),
                    "end": round(end, 3),
                }
            )
            cursor = end

        if word_timings:
            word_timings[-1]["end"] = round(duration, 3)

        return [unit_timing], word_timings

    flat_words: list[tuple[dict[str, Any], dict[str, Any], float]] = []

    for unit in units:
        for word in unit.get("words", []):
            flat_words.append((unit, word, spoken_word_weight(str(word.get("text", "")))))

    if not flat_words:
        unit_duration = duration / max(1, len(units))
        timings = []
        cursor = 0.0
        for index, unit in enumerate(units):
            start = cursor
            end = duration if index == len(units) - 1 else min(duration, start + unit_duration)
            timings.append({**unit, "start": round(start, 3), "end": round(end, 3)})
            cursor = end
        return timings, []

    total_weight = max(0.0001, sum(weight for _, _, weight in flat_words))
    word_timings: list[dict[str, Any]] = []
    cursor = 0.0

    for index, (unit, word, weight) in enumerate(flat_words):
        start = cursor
        end = duration if index == len(flat_words) - 1 else min(duration, start + duration * (weight / total_weight))
        word_timings.append(
            {
                "wordId": word["id"],
                "unitId": unit["unitId"],
                "text": word.get("text", ""),
                "pageNumber": word.get("pageNumber"),
                "x0": word.get("x0"),
                "y0": word.get("y0"),
                "x1": word.get("x1"),
                "y1": word.get("y1"),
                "start": round(start, 3),
                "end": round(end, 3),
            }
        )
        cursor = end

    unit_ranges: dict[str, tuple[float, float]] = {}
    for timing in word_timings:
        unit_id = str(timing["unitId"])
        start = float(timing["start"])
        end = float(timing["end"])
        if unit_id not in unit_ranges:
            unit_ranges[unit_id] = (start, end)
        else:
            unit_ranges[unit_id] = (unit_ranges[unit_id][0], end)

    unit_timings = []
    for unit in units:
        start, end = unit_ranges.get(str(unit["unitId"]), (0.0, duration))
        unit_timings.append({**unit, "start": round(start, 3), "end": round(end, 3)})

    return unit_timings, word_timings


def build_unit_timings(chunk: dict[str, Any], duration: float) -> list[dict[str, Any]]:
    unit_timings, _ = build_alignment_timings(chunk, duration)
    return unit_timings


def build_word_timings(chunk: dict[str, Any], duration: float) -> list[dict[str, Any]]:
    _, word_timings = build_alignment_timings(chunk, duration)
    return word_timings

def synthesize_chunk_to_file(
    document_id: str,
    chunk: dict[str, Any],
    voice_id: str,
    session_id: str | None = None,
    skip_categories: set[str] | None = None,
) -> dict[str, Any]:
    chunk_id = str(chunk["id"])
    spoken_text = cleaned_spoken_text(list(chunk.get("words", []))) if chunk.get("words") else str(chunk.get("text", ""))
    spoken_text = normalize_spaces(spoken_text)

    if not tts_text_is_speakable(spoken_text):
        raise skipped_chunk_http_exception(chunk_id)

    result = TTS_ENGINE.synthesize_chunk(
        document_id=document_id,
        chunk_id=chunk_id,
        text=spoken_text,
        requested_voice_id=voice_id,
        session_id=session_id,
    )

    return {
        "chunkId": chunk_id,
        "voiceId": result["voiceId"],
        "requestedVoiceId": result.get("requestedVoiceId", voice_id),
        "provider": result.get("provider", "unknown"),
        "fallbackUsed": bool(result.get("fallbackUsed", False)),
        "fallbackErrors": result.get("fallbackErrors", []),
        "audioUrl": result["audioUrl"],
        "duration": result["duration"],
        "cached": bool(result["cached"]),
        "text": chunk.get("text", ""),
        "normalizedText": result.get("normalizedText", ""),
        "unitIds": chunk.get("unitIds", []),
        "units": chunk.get("units", []),
        "unitTimings": build_unit_timings(chunk, float(result["duration"])),
        "wordTimings": build_word_timings(chunk, float(result["duration"])),
        "pageNumber": chunk.get("pageNumber"),
        "pageNumbers": chunk.get("pageNumbers", []),
        "skipProfile": ",".join(sorted(skip_categories or set())),
    }


def prepare_pdf_document(
    pdf_path: Path,
    document_id: str,
    original_filename: str,
    zoom: float = RENDER_ZOOM,
) -> dict[str, Any]:
    output_dir = DOCUMENTS_DIR / document_id
    stored_pdf_path = output_dir / "source.pdf"

    if output_dir.exists():
        shutil.rmtree(output_dir)

    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(pdf_path, stored_pdf_path)

    pages: list[dict[str, Any]] = []

    log(f"Öffne PDF: {pdf_path}")

    document = fitz.open(str(pdf_path))
    preview_image_url = ""
    preview_width = 0
    preview_height = 0

    try:
        page_count = len(document)
        log(f"PDF hat {page_count} Seiten")

        words, units, reading_blocks, chunks = extract_text_data(document)

        if page_count > 0:
            preview_width, preview_height = render_pdf_preview(document[0], preview_path(document_id))
            preview_image_url = preview_url(document_id)

        for page_index in range(page_count):
            page_number = page_index + 1
            page = document[page_index]
            page_width = max(1, int(round(float(page.rect.width) * zoom)))
            page_height = max(1, int(round(float(page.rect.height) * zoom)))

            pages.append(
                {
                    "pageNumber": page_number,
                    "width": page_width,
                    "height": page_height,
                    "imageUrl": "",
                }
            )
    finally:
        document.close()

    metadata = {
        "documentId": document_id,
        "filename": original_filename,
        "storedPdfUrl": f"/documents/{document_id}/source.pdf",
        "pageCount": len(pages),
        "renderZoom": zoom,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        "previewImageUrl": preview_image_url,
        "previewWidth": preview_width,
        "previewHeight": preview_height,
        "pages": pages,
        "words": words,
        "sentences": units,
        "readingUnits": units,
        "readingBlocks": reading_blocks,
        "chunks": chunks,
        "chunkingVersion": CHUNKING_VERSION,
    }

    write_metadata(document_id, metadata)

    log(f"Fertig gespeichert: {document_id}")

    return metadata


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/voices")
def get_voices() -> dict[str, Any]:
    specs = TTS_ENGINE.voice_specs()
    return {
        "defaultVoiceId": TTS_ENGINE.default_voice_id(),
        "variants": TTS_ENGINE.variant_catalog(),
        "voices": [spec.public_dict() for spec in specs],
    }


@app.post("/api/voices/{voice_id}/download")
def download_voice(voice_id: str) -> dict[str, Any]:
    try:
        return TTS_ENGINE.start_voice_download(voice_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Stimme konnte nicht heruntergeladen werden: {error}",
        ) from error


@app.get("/api/voices/{voice_id}/download")
def get_voice_download(voice_id: str) -> dict[str, Any]:
    try:
        return TTS_ENGINE.download_status(voice_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/api/voices/{voice_id}/download/pause")
def pause_voice_download(voice_id: str) -> dict[str, Any]:
    try:
        return TTS_ENGINE.pause_voice_download(voice_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/api/voices/{voice_id}/download/resume")
def resume_voice_download(voice_id: str) -> dict[str, Any]:
    try:
        return TTS_ENGINE.resume_voice_download(voice_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.delete("/api/voices/{voice_id}/download")
def cancel_voice_download(voice_id: str) -> dict[str, Any]:
    try:
        return TTS_ENGINE.cancel_voice_download(voice_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/tts/status")
def get_tts_status() -> dict[str, Any]:
    specs = TTS_ENGINE.voice_specs()
    return {
        "defaultVoiceId": TTS_ENGINE.default_voice_id(),
        "variants": TTS_ENGINE.variant_catalog(),
        "voices": [spec.public_dict() for spec in specs],
        "chunkingVersion": CHUNKING_VERSION,
        "targetChunkChars": TARGET_CHUNK_CHARS,
        "hardMaxChunkChars": HARD_MAX_CHUNK_CHARS,
    }


@app.get("/api/documents")
def list_documents() -> dict[str, Any]:
    DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)

    documents: list[dict[str, Any]] = []

    for document_dir in sorted(DOCUMENTS_DIR.iterdir(), key=lambda path: path.stat().st_mtime, reverse=True):
        if not document_dir.is_dir():
            continue

        metadata_file = document_dir / "metadata.json"

        if not metadata_file.exists():
            continue

        try:
            metadata = read_metadata(document_dir.name)
            metadata = ensure_document_preview(document_dir.name, metadata)

            documents.append(
                {
                    "documentId": metadata["documentId"],
                    "filename": metadata["filename"],
                    "pageCount": metadata["pageCount"],
                    "createdAt": metadata["createdAt"],
                    "updatedAt": metadata["updatedAt"],
                    "previewImageUrl": metadata.get("previewImageUrl", ""),
                    "previewWidth": metadata.get("previewWidth", 0),
                    "previewHeight": metadata.get("previewHeight", 0),
                }
            )
        except Exception as error:
            log(f"Überspringe defekte Metadaten in {metadata_file}: {error}")

    return {"documents": documents}


@app.post("/api/documents/{document_id}/rename")
def rename_document(document_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        metadata = read_metadata(document_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error

    requested_name = safe_filename(str(payload.get("filename", "")).strip())
    if not requested_name.lower().endswith(".pdf"):
        requested_name = f"{requested_name}.pdf"

    metadata["filename"] = requested_name
    metadata["updatedAt"] = now_iso()
    write_metadata(document_id, metadata)

    return {
        "documentId": document_id,
        "filename": requested_name,
        "updatedAt": metadata["updatedAt"],
    }


@app.delete("/api/documents/{document_id}")
def delete_document(document_id: str) -> dict[str, Any]:
    document_dir = DOCUMENTS_DIR / document_id
    if not document_dir.exists() or not document_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Dokument nicht gefunden: {document_id}")

    try:
        shutil.rmtree(document_dir)
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Dokument konnte nicht gelöscht werden: {error}") from error

    return {"documentId": document_id, "deleted": True}


@app.post("/api/documents/{document_id}/export")
def export_document(document_id: str, payload: dict[str, Any]) -> Response:
    try:
        metadata = read_metadata(document_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error

    highlights_raw = payload.get("highlights", [])
    if not isinstance(highlights_raw, list):
        raise HTTPException(status_code=400, detail="highlights muss eine Liste sein.")

    highlights = [highlight for highlight in highlights_raw if isinstance(highlight, dict)]

    try:
        pdf_bytes = export_pdf_with_annotations(document_id, metadata, highlights)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"PDF-Export fehlgeschlagen: {error}") from error

    filename = safe_filename(str(metadata.get("filename", "document.pdf")))
    ascii_filename = re.sub(r"[^A-Za-z0-9._-]", "_", filename) or "document.pdf"

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{ascii_filename}"'},
    )


@app.get("/api/documents/{document_id}")
def get_document(document_id: str) -> dict[str, Any]:
    try:
        metadata = read_metadata(document_id)
        metadata = ensure_chunks(metadata, document_id)
        write_metadata(document_id, metadata)
        return metadata
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/debug/documents/{document_id}/segments")
def debug_document_segments(document_id: str) -> dict[str, Any]:
    try:
        metadata = read_metadata(document_id)
        metadata = ensure_chunks(metadata, document_id)
        write_metadata(document_id, metadata)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error

    return {
        "documentId": metadata.get("documentId"),
        "filename": metadata.get("filename"),
        "pageCount": metadata.get("pageCount"),
        "unitCount": len(metadata.get("sentences", [])),
        "chunkCount": len(metadata.get("chunks", [])),
        "units": metadata.get("sentences", []),
        "chunks": metadata.get("chunks", []),
    }


@app.post("/api/documents/{document_id}/tts/chunks/{chunk_id}")
def create_chunk_audio(
    document_id: str,
    chunk_id: str,
    voice_id: str | None = Query(default=None, alias="voiceId"),
    session_id: str | None = Query(default=None, alias="sessionId"),
    skip_categories_raw: str | None = Query(default=None, alias="skipCategories"),
) -> dict[str, Any]:
    try:
        metadata = read_metadata_with_chunks(document_id)
        chunk = get_chunk_by_id(metadata, chunk_id)
        skip_categories = parse_skip_categories(skip_categories_raw)
        spoken_chunk = filtered_chunk_for_tts(chunk, skip_categories)

        if (
            spoken_chunk is None
            or not normalize_spaces(str(spoken_chunk.get("text", "")))
            or not tts_text_is_speakable(str(spoken_chunk.get("text", "")))
        ):
            raise skipped_chunk_http_exception(chunk_id)

        effective_voice_id = voice_id or TTS_ENGINE.default_voice_id()
        return synthesize_chunk_to_file(
            document_id=document_id,
            chunk=spoken_chunk,
            voice_id=effective_voice_id,
            session_id=session_id,
            skip_categories=skip_categories,
        )
    except TtsCancelledError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except HTTPException:
        raise
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except Exception as error:
        LOGGER.exception(
            "TTS-Chunk fehlgeschlagen document=%s chunk=%s voice=%s skip=%s filteredText=%r",
            document_id,
            chunk_id,
            voice_id,
            skip_categories_raw,
            str(locals().get("spoken_chunk", {}).get("text", ""))[:1200]
            if isinstance(locals().get("spoken_chunk"), dict)
            else "",
        )
        raise HTTPException(
            status_code=500,
            detail={
                "code": "TTS_SYNTHESIS_FAILED",
                "chunkId": chunk_id,
                "message": f"Chunk-Audio konnte nicht erzeugt werden: {error}",
            },
        ) from error


@app.post("/api/tts/sessions/{session_id}/cancel")
def cancel_tts_session(session_id: str) -> dict[str, Any]:
    return TTS_ENGINE.cancel_session(session_id)


@app.post("/api/documents/{document_id}/tts/preload-chunks")
def preload_chunk_audio(
    document_id: str,
    payload: dict[str, Any],
    voice_id: str | None = Query(default=None, alias="voiceId"),
    session_id: str | None = Query(default=None, alias="sessionId"),
    skip_categories_raw: str | None = Query(default=None, alias="skipCategories"),
) -> dict[str, Any]:
    chunk_ids_raw = payload.get("chunkIds", [])

    if not isinstance(chunk_ids_raw, list):
        raise HTTPException(status_code=400, detail="chunkIds muss eine Liste sein.")

    chunk_ids = [str(chunk_id) for chunk_id in chunk_ids_raw]

    try:
        metadata = read_metadata_with_chunks(document_id)
        results: list[dict[str, Any]] = []

        for chunk_id in chunk_ids:
            if TTS_ENGINE.is_session_cancelled(session_id):
                raise TtsCancelledError("TTS-Generierung wurde abgebrochen.")

            chunk = get_chunk_by_id(metadata, chunk_id)
            skip_categories = parse_skip_categories(skip_categories_raw)
            spoken_chunk = filtered_chunk_for_tts(chunk, skip_categories)
            if (
                spoken_chunk is None
                or not normalize_spaces(str(spoken_chunk.get("text", "")))
                or not tts_text_is_speakable(str(spoken_chunk.get("text", "")))
            ):
                continue

            effective_voice_id = voice_id or TTS_ENGINE.default_voice_id()

            try:
                result = synthesize_chunk_to_file(
                    document_id=document_id,
                    chunk=spoken_chunk,
                    voice_id=effective_voice_id,
                    session_id=session_id,
                    skip_categories=skip_categories,
                )
            except HTTPException as error:
                if error.status_code == 409:
                    continue
                LOGGER.warning(
                    "Preload-Chunk übersprungen document=%s chunk=%s status=%s detail=%s",
                    document_id,
                    chunk_id,
                    error.status_code,
                    error.detail,
                )
                continue
            except TtsCancelledError:
                raise
            except Exception as error:
                LOGGER.exception(
                    "Preload-TTS fehlgeschlagen document=%s chunk=%s voice=%s",
                    document_id,
                    chunk_id,
                    effective_voice_id,
                )
                continue

            results.append(result)

        return {
            "documentId": document_id,
            "voiceId": voice_id or TTS_ENGINE.default_voice_id(),
            "count": len(results),
            "chunks": results,
        }
    except TtsCancelledError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Preload fehlgeschlagen: {error}") from error


@app.post("/api/documents/upload")
async def upload_document(file: UploadFile = File(...)) -> dict[str, Any]:
    if file.filename is None:
        raise HTTPException(status_code=400, detail="Dateiname fehlt.")

    filename = safe_filename(file.filename)

    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Nur PDF-Dateien sind erlaubt.")

    temp_path = UPLOAD_DIR / filename

    log(f"Upload empfangen: {filename}")

    try:
        with open(temp_path, "wb") as output_file:
            shutil.copyfileobj(file.file, output_file)

        document_hash = hash_file(temp_path)
        document_id = f"{safe_stem(filename)}_{document_hash}"

        return prepare_pdf_document(
            pdf_path=temp_path,
            document_id=document_id,
            original_filename=filename,
            zoom=RENDER_ZOOM,
        )
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"PDF konnte nicht verarbeitet werden: {error}") from error