import hashlib
import json
import re
import shutil
import subprocess
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fitz
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
DOCUMENTS_DIR = DATA_DIR / "documents"
PIPER_VOICES_DIR = DATA_DIR / "piper_voices"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
PIPER_VOICES_DIR.mkdir(parents=True, exist_ok=True)

PIPER_COMMAND = ["python", "-m", "piper"]
DEFAULT_PIPER_VOICE_ID = "de_DE-thorsten-medium"
RENDER_ZOOM = 2.0
TARGET_CHUNK_CHARS = 700
MAX_UNITS_PER_CHUNK = 5
WORDS_PER_MINUTE_ESTIMATE = 165.0

app = FastAPI(title="SmartVoice Backend")

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


def metadata_path(document_id: str) -> Path:
    return DOCUMENTS_DIR / document_id / "metadata.json"


def read_metadata(document_id: str) -> dict[str, Any]:
    path = metadata_path(document_id)

    if not path.exists():
        raise FileNotFoundError(f"Metadaten fehlen für Dokument: {document_id}")

    with open(path, "r", encoding="utf-8") as file:
        return json.load(file)


def write_metadata(document_id: str, metadata: dict[str, Any]) -> None:
    path = metadata_path(document_id)
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w", encoding="utf-8") as file:
        json.dump(metadata, file, ensure_ascii=False, indent=2)


def normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalize_tts_text(text: str) -> str:
    replacements = {
        " KI ": " künstliche Intelligenz ",
        " AI ": " Artificial Intelligence ",
        " ML ": " Machine Learning ",
        " LLM ": " Large Language Model ",
        " PDF ": " P D F ",
        " OCR ": " O C R ",
        " TTS ": " Text to Speech ",
    }

    normalized = f" {normalize_spaces(text)} "

    for source, target in replacements.items():
        normalized = normalized.replace(source, target)

    return normalize_spaces(normalized)


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

    if re.fullmatch(r"\d+\.", cleaned):
        return False

    if re.fullmatch(r"\d+(\.\d+)+\.?", cleaned):
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

    y_center = (line["y0"] + line["y1"]) / 2

    if y_center > page_height * 0.94 and is_probably_page_number(text):
        return True

    if y_center < page_height * 0.04 and len(text) < 80:
        return True

    return False


def extract_words_and_lines(document: fitz.Document) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    all_words: list[dict[str, Any]] = []
    all_lines: list[dict[str, Any]] = []
    global_word_index = 1

    for page_index in range(len(document)):
        page_number = page_index + 1
        page = document[page_index]
        page_height = float(page.rect.height)

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
            x0, y0, x1, y1, text, block_number, line_number, word_number = raw_word
            clean_text = normalize_spaces(str(text))

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
            }

            all_words.append(word)
            line_key = (int(block_number), int(line_number))
            line_map.setdefault(line_key, []).append(word)
            global_word_index += 1

        for (block_number, line_number), line_words in line_map.items():
            sorted_line_words = sorted(line_words, key=lambda word: (word["x0"], word["wordNumber"]))
            text = normalize_spaces(" ".join(word["text"] for word in sorted_line_words))

            if not text:
                continue

            line = {
                "id": f"l_{page_number:04d}_{block_number:04d}_{line_number:04d}",
                "pageNumber": page_number,
                "blockNumber": block_number,
                "lineNumber": line_number,
                "text": text,
                "x0": round(min(word["x0"] for word in sorted_line_words), 2),
                "y0": round(min(word["y0"] for word in sorted_line_words), 2),
                "x1": round(max(word["x1"] for word in sorted_line_words), 2),
                "y1": round(max(word["y1"] for word in sorted_line_words), 2),
                "wordIds": [word["id"] for word in sorted_line_words],
                "words": sorted_line_words,
            }

            if should_skip_line(line, page_height):
                continue

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


def create_segment(segment_index: int, words: list[dict[str, Any]], segment_type: str = "text") -> dict[str, Any] | None:
    clean_words = [word for word in words if normalize_spaces(word["text"])]

    if not clean_words:
        return None

    text = normalize_spaces(" ".join(word["text"] for word in clean_words))

    if not text:
        return None

    page_numbers = sorted({int(word["pageNumber"]) for word in clean_words})

    return {
        "id": f"u_{segment_index:06d}",
        "text": text,
        "pageNumber": page_numbers[0],
        "pageNumbers": page_numbers,
        "wordIds": [word["id"] for word in clean_words],
        "lineBoxes": merge_words_to_line_boxes(clean_words),
        "type": segment_type,
        "readMode": "tts_original",
        "pauseAfterMs": 250,
        "source": "pdf_text",
    }


def build_default_segments(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    segment_index = 1

    current_words: list[dict[str, Any]] = []
    previous_line: dict[str, Any] | None = None

    for line in lines:
        line_words = line["words"]

        if previous_line is not None:
            page_changed = line["pageNumber"] != previous_line["pageNumber"]
            block_changed = line["blockNumber"] != previous_line["blockNumber"]

            if page_changed or block_changed:
                if current_words:
                    segment = create_segment(segment_index, current_words)
                    if segment is not None:
                        segments.append(segment)
                        segment_index += 1
                    current_words = []

        for word in line_words:
            current_words.append(word)

            if is_sentence_end(current_words):
                segment = create_segment(segment_index, current_words)
                if segment is not None:
                    segments.append(segment)
                    segment_index += 1
                current_words = []

        previous_line = line

    if current_words:
        segment = create_segment(segment_index, current_words)
        if segment is not None:
            segments.append(segment)

    return segments


def estimate_text_duration_seconds(text: str) -> float:
    words = [part for part in normalize_spaces(text).split(" ") if part]
    word_count = max(1, len(words))
    return max(1.0, word_count / WORDS_PER_MINUTE_ESTIMATE * 60.0)


def build_tts_chunks(units: list[dict[str, Any]]) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    current_units: list[dict[str, Any]] = []
    current_chars = 0

    def flush() -> None:
        nonlocal current_units
        nonlocal current_chars

        if not current_units:
            return

        chunk_index = len(chunks) + 1
        chunk_id = f"c_{chunk_index:06d}"
        text = normalize_spaces(" ".join(unit["text"] for unit in current_units))
        page_numbers = sorted({page_number for unit in current_units for page_number in unit.get("pageNumbers", [])})

        chunks.append(
            {
                "id": chunk_id,
                "text": text,
                "unitIds": [unit["id"] for unit in current_units],
                "units": [
                    {
                        "unitId": unit["id"],
                        "text": unit["text"],
                        "type": unit.get("type", "text"),
                        "source": unit.get("source", "pdf_text"),
                        "pageNumber": unit.get("pageNumber"),
                        "pageNumbers": unit.get("pageNumbers", []),
                        "lineBoxes": unit.get("lineBoxes", []),
                        "wordIds": unit.get("wordIds", []),
                    }
                    for unit in current_units
                ],
                "pageNumber": current_units[0].get("pageNumber"),
                "pageNumbers": page_numbers,
                "estimatedDuration": round(estimate_text_duration_seconds(text), 3),
                "charCount": len(text),
                "wordCount": len([part for part in text.split(" ") if part]),
            }
        )

        current_units = []
        current_chars = 0

    for unit in units:
        text = normalize_spaces(str(unit.get("text", "")))

        if not text:
            continue

        next_chars = len(text)
        would_exceed_chars = current_units and current_chars + next_chars > TARGET_CHUNK_CHARS
        would_exceed_units = current_units and len(current_units) >= MAX_UNITS_PER_CHUNK

        if would_exceed_chars or would_exceed_units:
            flush()

        current_units.append(unit)
        current_chars += next_chars

    flush()

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


def ensure_chunks(metadata: dict[str, Any]) -> dict[str, Any]:
    units = metadata.get("sentences", [])

    if "chunks" not in metadata or not isinstance(metadata.get("chunks"), list):
        metadata["chunks"] = build_tts_chunks(units)
        metadata["updatedAt"] = now_iso()

    return metadata


def get_chunk_by_id(metadata: dict[str, Any], chunk_id: str) -> dict[str, Any]:
    metadata = ensure_chunks(metadata)

    for chunk in metadata.get("chunks", []):
        if chunk.get("id") == chunk_id:
            return chunk

    raise FileNotFoundError(f"Chunk nicht gefunden: {chunk_id}")


def get_piper_voice_dir(voice_id: str) -> Path:
    return PIPER_VOICES_DIR / safe_id(voice_id)


def get_piper_voice_model_path(voice_id: str) -> Path:
    voice_dir = get_piper_voice_dir(voice_id)
    matches = sorted(voice_dir.glob("*.onnx"))

    if not matches:
        raise FileNotFoundError(f"Kein Piper .onnx Modell gefunden für voiceId={voice_id} in {voice_dir}")

    return matches[0]


def get_piper_voice_config_path(voice_id: str, model_path: Path) -> Path:
    direct = Path(str(model_path) + ".json")

    if direct.exists():
        return direct

    voice_dir = get_piper_voice_dir(voice_id)
    matches = sorted(voice_dir.glob("*.onnx.json"))

    if not matches:
        raise FileNotFoundError(f"Keine Piper .onnx.json Config gefunden für voiceId={voice_id} in {voice_dir}")

    return matches[0]


def list_piper_voices() -> list[dict[str, Any]]:
    voices: list[dict[str, Any]] = []

    if not PIPER_VOICES_DIR.exists():
        return voices

    for voice_dir in sorted(PIPER_VOICES_DIR.iterdir(), key=lambda path: path.name.lower()):
        if not voice_dir.is_dir():
            continue

        onnx_files = sorted(voice_dir.glob("*.onnx"))
        json_files = sorted(voice_dir.glob("*.onnx.json"))

        if not onnx_files or not json_files:
            continue

        voice_id = voice_dir.name
        voices.append(
            {
                "id": voice_id,
                "name": voice_id.replace("_", " ").replace("-", " "),
                "modelFilename": onnx_files[0].name,
                "configFilename": json_files[0].name,
                "available": True,
                "isDefault": voice_id == DEFAULT_PIPER_VOICE_ID,
            }
        )

    return voices


def get_wav_duration_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as wav_file:
        frames = wav_file.getnframes()
        rate = wav_file.getframerate()

        if rate <= 0:
            return 0.0

        return frames / float(rate)


def build_unit_timings(chunk: dict[str, Any], duration: float) -> list[dict[str, Any]]:
    units = chunk.get("units", [])

    if not units:
        return []

    weights = [max(1, len(normalize_spaces(str(unit.get("text", ""))))) for unit in units]
    total_weight = max(1, sum(weights))

    timings: list[dict[str, Any]] = []
    cursor = 0.0

    for unit, weight in zip(units, weights):
        share = weight / total_weight
        unit_duration = duration * share
        start = cursor
        end = min(duration, start + unit_duration)

        timings.append(
            {
                "unitId": unit["unitId"],
                "start": round(start, 3),
                "end": round(end, 3),
                "text": unit.get("text", ""),
                "type": unit.get("type", "text"),
                "source": unit.get("source", "pdf_text"),
                "pageNumber": unit.get("pageNumber"),
                "pageNumbers": unit.get("pageNumbers", []),
                "lineBoxes": unit.get("lineBoxes", []),
                "wordIds": unit.get("wordIds", []),
            }
        )

        cursor = end

    if timings:
        timings[-1]["end"] = round(duration, 3)

    return timings


def synthesize_chunk_to_file(
    document_id: str,
    chunk: dict[str, Any],
    voice_id: str,
) -> dict[str, Any]:
    model_path = get_piper_voice_model_path(voice_id)
    config_path = get_piper_voice_config_path(voice_id, model_path)

    document_dir = DOCUMENTS_DIR / document_id
    audio_dir = document_dir / "audio" / "piper" / safe_id(voice_id) / "chunks"
    audio_dir.mkdir(parents=True, exist_ok=True)

    chunk_id = str(chunk["id"])
    wav_name = f"{safe_id(chunk_id)}.wav"
    wav_path = audio_dir / wav_name

    if wav_path.exists():
        duration = get_wav_duration_seconds(wav_path)
        return {
            "chunkId": chunk_id,
            "voiceId": voice_id,
            "audioUrl": f"/documents/{document_id}/audio/piper/{safe_id(voice_id)}/chunks/{wav_name}",
            "duration": round(duration, 3),
            "cached": True,
            "text": chunk.get("text", ""),
            "unitIds": chunk.get("unitIds", []),
            "units": chunk.get("units", []),
            "unitTimings": build_unit_timings(chunk, duration),
            "pageNumber": chunk.get("pageNumber"),
            "pageNumbers": chunk.get("pageNumbers", []),
        }

    text = normalize_tts_text(str(chunk.get("text", "")))

    if not text:
        raise ValueError(f"Chunk enthält keinen Text: {chunk_id}")

    log(f"Piper synthetisiert {chunk_id} mit {voice_id}: {text[:120]}")

    command = [
        *PIPER_COMMAND,
        "-m",
        str(model_path),
        "-c",
        str(config_path),
        "-f",
        str(wav_path),
    ]

    process = subprocess.run(
        command,
        input=text,
        text=True,
        capture_output=True,
        check=False,
    )

    if process.returncode != 0:
        raise RuntimeError(
            f"Piper fehlgeschlagen.\nCommand: {' '.join(command)}\nSTDOUT:\n{process.stdout}\nSTDERR:\n{process.stderr}"
        )

    duration = get_wav_duration_seconds(wav_path)

    return {
        "chunkId": chunk_id,
        "voiceId": voice_id,
        "audioUrl": f"/documents/{document_id}/audio/piper/{safe_id(voice_id)}/chunks/{wav_name}",
        "duration": round(duration, 3),
        "cached": False,
        "text": chunk.get("text", ""),
        "unitIds": chunk.get("unitIds", []),
        "units": chunk.get("units", []),
        "unitTimings": build_unit_timings(chunk, duration),
        "pageNumber": chunk.get("pageNumber"),
        "pageNumbers": chunk.get("pageNumbers", []),
    }


def render_pdf_to_images(
    pdf_path: Path,
    document_id: str,
    original_filename: str,
    zoom: float = RENDER_ZOOM,
) -> dict[str, Any]:
    output_dir = DOCUMENTS_DIR / document_id
    pages_dir = output_dir / "pages"
    stored_pdf_path = output_dir / "source.pdf"

    if output_dir.exists():
        shutil.rmtree(output_dir)

    pages_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(pdf_path, stored_pdf_path)

    pages: list[dict[str, Any]] = []

    log(f"Öffne PDF: {pdf_path}")

    document = fitz.open(str(pdf_path))

    try:
        page_count = len(document)
        log(f"PDF hat {page_count} Seiten")

        words, units, reading_blocks, chunks = extract_text_data(document)

        for page_index in range(page_count):
            page_number = page_index + 1
            page = document[page_index]

            log(f"Rendere Seite {page_number}/{page_count}")

            matrix = fitz.Matrix(zoom, zoom)
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)

            image_name = f"page_{page_number:03d}.png"
            image_path = pages_dir / image_name
            pixmap.save(str(image_path))

            pages.append(
                {
                    "pageNumber": page_number,
                    "width": pixmap.width,
                    "height": pixmap.height,
                    "imageUrl": f"/documents/{document_id}/pages/{image_name}",
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
        "pages": pages,
        "words": words,
        "sentences": units,
        "readingUnits": units,
        "readingBlocks": reading_blocks,
        "chunks": chunks,
    }

    write_metadata(document_id, metadata)

    log(f"Fertig gespeichert: {document_id}")

    return metadata


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/voices")
def get_voices() -> dict[str, Any]:
    voices = list_piper_voices()

    return {
        "defaultVoiceId": DEFAULT_PIPER_VOICE_ID,
        "voices": voices,
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
            with open(metadata_file, "r", encoding="utf-8") as file:
                metadata = json.load(file)

            documents.append(
                {
                    "documentId": metadata["documentId"],
                    "filename": metadata["filename"],
                    "pageCount": metadata["pageCount"],
                    "createdAt": metadata["createdAt"],
                    "updatedAt": metadata["updatedAt"],
                }
            )
        except Exception as error:
            log(f"Überspringe defekte Metadaten in {metadata_file}: {error}")

    return {"documents": documents}


@app.get("/api/documents/{document_id}")
def get_document(document_id: str) -> dict[str, Any]:
    try:
        metadata = read_metadata(document_id)
        metadata = ensure_chunks(metadata)
        write_metadata(document_id, metadata)
        return metadata
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/debug/documents/{document_id}/segments")
def debug_document_segments(document_id: str) -> dict[str, Any]:
    try:
        metadata = read_metadata(document_id)
        metadata = ensure_chunks(metadata)
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
    voice_id: str = Query(default=DEFAULT_PIPER_VOICE_ID, alias="voiceId"),
) -> dict[str, Any]:
    try:
        metadata = read_metadata(document_id)
        metadata = ensure_chunks(metadata)
        chunk = get_chunk_by_id(metadata, chunk_id)

        return synthesize_chunk_to_file(
            document_id=document_id,
            chunk=chunk,
            voice_id=voice_id,
        )
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Chunk-Audio konnte nicht erzeugt werden: {error}") from error


@app.post("/api/documents/{document_id}/tts/preload-chunks")
def preload_chunk_audio(
    document_id: str,
    payload: dict[str, Any],
    voice_id: str = Query(default=DEFAULT_PIPER_VOICE_ID, alias="voiceId"),
) -> dict[str, Any]:
    chunk_ids_raw = payload.get("chunkIds", [])

    if not isinstance(chunk_ids_raw, list):
        raise HTTPException(status_code=400, detail="chunkIds muss eine Liste sein.")

    chunk_ids = [str(chunk_id) for chunk_id in chunk_ids_raw]

    try:
        metadata = read_metadata(document_id)
        metadata = ensure_chunks(metadata)
        results: list[dict[str, Any]] = []

        for chunk_id in chunk_ids:
            chunk = get_chunk_by_id(metadata, chunk_id)
            result = synthesize_chunk_to_file(
                document_id=document_id,
                chunk=chunk,
                voice_id=voice_id,
            )
            results.append(result)

        return {
            "documentId": document_id,
            "voiceId": voice_id,
            "count": len(results),
            "chunks": results,
        }
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

        return render_pdf_to_images(
            pdf_path=temp_path,
            document_id=document_id,
            original_filename=filename,
            zoom=RENDER_ZOOM,
        )
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"PDF konnte nicht verarbeitet werden: {error}") from error