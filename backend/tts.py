import json
import re
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException


BASE_DIR = Path(__file__).resolve().parent
DOCUMENTS_DIR = BASE_DIR / "data" / "documents"

router = APIRouter()


def normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def metadata_path(document_id: str) -> Path:
    return DOCUMENTS_DIR / document_id / "metadata.json"


def read_metadata(document_id: str) -> dict[str, Any]:
    path = metadata_path(document_id)

    if not path.exists():
        raise FileNotFoundError(f"Metadaten fehlen für Dokument: {document_id}")

    with open(path, "r", encoding="utf-8") as file:
        return json.load(file)


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


@router.post("/api/documents/{document_id}/tts/segments/{segment_id}")
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