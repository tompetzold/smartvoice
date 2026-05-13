import hashlib
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fitz
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
DOCUMENTS_DIR = DATA_DIR / "documents"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="VoiceMaster Backend")

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
    print(f"[VoiceMaster {timestamp}] {message}", flush=True)


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


def create_segment(segment_index: int, words: list[dict[str, Any]], segment_type: str = "default") -> dict[str, Any] | None:
    clean_words = [word for word in words if normalize_spaces(word["text"])]

    if not clean_words:
        return None

    text = normalize_spaces(" ".join(word["text"] for word in clean_words))

    if not text:
        return None

    page_numbers = sorted({int(word["pageNumber"]) for word in clean_words})

    return {
        "id": f"s_{segment_index:06d}",
        "text": text,
        "pageNumber": page_numbers[0],
        "pageNumbers": page_numbers,
        "wordIds": [word["id"] for word in clean_words],
        "lineBoxes": merge_words_to_line_boxes(clean_words),
        "type": segment_type,
        "readMode": "tts_original",
        "pauseAfterMs": 250,
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


def extract_text_data(document: fitz.Document) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    words, lines = extract_words_and_lines(document)
    segments = build_default_segments(lines)
    reading_blocks = build_reading_blocks_from_segments(segments)

    log(f"Textdaten: words={len(words)}, lines={len(lines)}, segments={len(segments)}")

    return words, segments, reading_blocks


def get_segment_by_id(metadata: dict[str, Any], segment_id: str) -> dict[str, Any]:
    for segment in metadata.get("sentences", []):
        if segment.get("id") == segment_id:
            return segment

    raise FileNotFoundError(f"Segment nicht gefunden: {segment_id}")


def safe_audio_filename(segment_id: str) -> str:
    cleaned = "".join(char if char.isalnum() or char in ("-", "_") else "_" for char in segment_id)
    return f"{cleaned}.wav"


def synthesize_segment_with_macos_say(
    document_id: str,
    segment: dict[str, Any],
    voice: str = "Anna",
    rate: int = 185,
) -> dict[str, Any]:
    document_dir = DOCUMENTS_DIR / document_id
    audio_dir = document_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    segment_id = str(segment["id"])
    wav_name = safe_audio_filename(segment_id)
    wav_path = audio_dir / wav_name
    aiff_path = audio_dir / f"{segment_id}.aiff"

    if wav_path.exists():
        return {
            "segmentId": segment_id,
            "audioUrl": f"/documents/{document_id}/audio/{wav_name}",
            "cached": True,
        }

    text = normalize_spaces(str(segment.get("text", "")))

    if not text:
        raise ValueError(f"Segment enthält keinen Text: {segment_id}")

    say_command = [
        "say",
        "-v",
        voice,
        "-r",
        str(rate),
        "-o",
        str(aiff_path),
        text,
    ]

    convert_command = [
        "afconvert",
        "-f",
        "WAVE",
        "-d",
        "LEI16",
        str(aiff_path),
        str(wav_path),
    ]

    subprocess.run(say_command, check=True)
    subprocess.run(convert_command, check=True)

    if aiff_path.exists():
        aiff_path.unlink()

    return {
        "segmentId": segment_id,
        "audioUrl": f"/documents/{document_id}/audio/{wav_name}",
        "cached": False,
    }


def render_pdf_to_images(
    pdf_path: Path,
    document_id: str,
    original_filename: str,
    zoom: float = 2.0,
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

        words, sentences, reading_blocks = extract_text_data(document)

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
        "sentences": sentences,
        "readingBlocks": reading_blocks,
    }

    write_metadata(document_id, metadata)

    log(f"Fertig gespeichert: {document_id}")

    return metadata


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
        return read_metadata(document_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/debug/documents/{document_id}/segments")
def debug_document_segments(document_id: str) -> dict[str, Any]:
    try:
        metadata = read_metadata(document_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error

    return {
        "documentId": metadata.get("documentId"),
        "filename": metadata.get("filename"),
        "pageCount": metadata.get("pageCount"),
        "segmentCount": len(metadata.get("sentences", [])),
        "segments": metadata.get("sentences", []),
    }


@app.post("/api/documents/{document_id}/tts/segments/{segment_id}")
def create_segment_audio(document_id: str, segment_id: str) -> dict[str, Any]:
    try:
        metadata = read_metadata(document_id)
        segment = get_segment_by_id(metadata, segment_id)

        return synthesize_segment_with_macos_say(
            document_id=document_id,
            segment=segment,
            voice="Anna",
            rate=185,
        )
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except subprocess.CalledProcessError as error:
        raise HTTPException(status_code=500, detail=f"TTS-Prozess fehlgeschlagen: {error}") from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"TTS konnte nicht erzeugt werden: {error}") from error


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
            zoom=2.0,
        )
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"PDF konnte nicht verarbeitet werden: {error}") from error