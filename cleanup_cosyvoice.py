from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ROOT_DIR / "backend"
DATA_DIR = BACKEND_DIR / "data"
DOCUMENTS_DIR = DATA_DIR / "documents"
TTS_MODELS_DIR = DATA_DIR / "tts_models"
DOWNLOAD_STATE_PATH = TTS_MODELS_DIR / "download-state.json"

COSYVOICE_CONTAINER = "smartvoice-cosyvoice"
COSYVOICE_IMAGE = "thorstenvoice/cosyvoice-tts"
COSYVOICE_VOLUME = "smartvoice_cosyvoice_models"
COSYVOICE_VOICE_ID = "cosyvoice:thorsten"

HF_CACHE_DIRS = (
    Path.home() / ".cache" / "huggingface" / "hub" / "models--FunAudioLLM--Fun-CosyVoice3-0.5B-2512",
    Path.home() / ".cache" / "huggingface" / "hub" / "models--Thorsten-Voice--CosyVoice3",
)


def human_size(value: int) -> str:
    size = float(max(0, value))
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024.0 or unit == "TB":
            return f"{size:.2f} {unit}"
        size /= 1024.0
    return f"{size:.2f} TB"


def path_size(path: Path) -> int:
    if not path.exists() and not path.is_symlink():
        return 0
    if path.is_file() or path.is_symlink():
        try:
            return path.stat().st_size
        except OSError:
            return 0

    total = 0
    for child in path.rglob("*"):
        try:
            if child.is_file() and not child.is_symlink():
                total += child.stat().st_size
        except OSError:
            pass
    return total


def remove_path(path: Path, dry_run: bool) -> int:
    if not path.exists() and not path.is_symlink():
        return 0

    size = path_size(path)
    print(f"{'[DRY-RUN] ' if dry_run else ''}Entferne: {path} ({human_size(size)})")

    if dry_run:
        return size

    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)

    return size


def docker_available() -> bool:
    return shutil.which("docker") is not None


def docker_command(args: list[str], dry_run: bool) -> None:
    printable = "docker " + " ".join(args)
    print(f"{'[DRY-RUN] ' if dry_run else ''}{printable}")

    if dry_run or not docker_available():
        return

    subprocess.run(
        ["docker", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )


def cleanup_download_state(dry_run: bool) -> None:
    if not DOWNLOAD_STATE_PATH.exists():
        return

    try:
        payload = json.loads(DOWNLOAD_STATE_PATH.read_text(encoding="utf-8"))
    except Exception as error:
        print(f"Download-State konnte nicht gelesen werden: {error}")
        return

    states = payload.get("states")
    if not isinstance(states, dict) or COSYVOICE_VOICE_ID not in states:
        return

    print(
        f"{'[DRY-RUN] ' if dry_run else ''}Entferne {COSYVOICE_VOICE_ID} "
        f"aus {DOWNLOAD_STATE_PATH}"
    )

    if dry_run:
        return

    states.pop(COSYVOICE_VOICE_ID, None)
    payload["states"] = states
    DOWNLOAD_STATE_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def cleanup_document_audio(dry_run: bool) -> int:
    if not DOCUMENTS_DIR.exists():
        return 0

    removed = 0
    for document_dir in DOCUMENTS_DIR.iterdir():
        if not document_dir.is_dir():
            continue
        removed += remove_path(document_dir / "audio" / "cosyvoice", dry_run)
    return removed


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Entfernt ausschließlich alte CosyVoice-Reste aus SmartVoice."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Nur anzeigen, was entfernt würde.",
    )
    args = parser.parse_args()

    print("SmartVoice CosyVoice Cleanup")
    print("============================")

    if docker_available():
        docker_command(["rm", "-f", COSYVOICE_CONTAINER], args.dry_run)
        docker_command(["volume", "rm", "-f", COSYVOICE_VOLUME], args.dry_run)
        docker_command(["image", "rm", "-f", COSYVOICE_IMAGE], args.dry_run)
    else:
        print("Docker CLI nicht gefunden; Docker-Ressourcen werden übersprungen.")

    removed_bytes = 0
    removed_bytes += remove_path(TTS_MODELS_DIR / "cosyvoice", args.dry_run)
    removed_bytes += cleanup_document_audio(args.dry_run)

    for cache_dir in HF_CACHE_DIRS:
        removed_bytes += remove_path(cache_dir, args.dry_run)

    cleanup_download_state(args.dry_run)

    print()
    if args.dry_run:
        print(f"Würde lokal ungefähr {human_size(removed_bytes)} entfernen.")
        print("Docker-Volume/Image-Größen sind darin nicht enthalten.")
    else:
        print(f"Lokale Dateien entfernt: ungefähr {human_size(removed_bytes)}")
        print("CosyVoice-Container, -Volume und -Image wurden ebenfalls entfernt, sofern vorhanden.")
        print("Piper und Kokoro wurden nicht verändert.")


if __name__ == "__main__":
    main()
