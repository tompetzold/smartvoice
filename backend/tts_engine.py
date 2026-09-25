from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import logging
import re
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.request
import wave
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from tts_text import normalize_german_tts_text


LOGGER = logging.getLogger("uvicorn.error")

DEFAULT_VOICE_ID = "piper:de_DE-thorsten-high"
CACHE_VERSION = "thorsten-variants-v1"

PIPER_REPO_BASE = "https://huggingface.co/Thorsten-Voice/Piper/resolve/main"
KOKORO_REPO_BASE = "https://huggingface.co/Thorsten-Voice/Kokoro/resolve/main"


VOICE_CATALOG: tuple[dict[str, Any], ...] = (
    {
        "id": "piper:de_DE-thorsten-high",
        "name": "Thorsten",
        "provider": "piper",
        "variantLabel": "Piper",
        "language": "Deutsch",
        "quality": "High",
        "requiredBytes": 113_905_000,
        "requiredSizeLabel": "114 MB",
        "piperVoiceId": "de_DE-thorsten-high",
        "files": (
            ("de_DE-thorsten-high.onnx", f"{PIPER_REPO_BASE}/de_DE-thorsten-high.onnx?download=true"),
            ("de_DE-thorsten-high.onnx.json", f"{PIPER_REPO_BASE}/de_DE-thorsten-high.onnx.json?download=true"),
        ),
    },
    {
        "id": "piper:de_DE-thorsten-medium",
        "name": "Thorsten",
        "provider": "piper",
        "variantLabel": "Piper",
        "language": "Deutsch",
        "quality": "Medium",
        "requiredBytes": 63_210_000,
        "requiredSizeLabel": "63 MB",
        "piperVoiceId": "de_DE-thorsten-medium",
        "files": (
            ("de_DE-thorsten-medium.onnx", f"{PIPER_REPO_BASE}/de_DE-thorsten-medium.onnx?download=true"),
            ("de_DE-thorsten-medium.onnx.json", f"{PIPER_REPO_BASE}/de_DE-thorsten-medium.onnx.json?download=true"),
        ),
    },
    {
        "id": "kokoro:thorsten",
        "name": "Thorsten",
        "provider": "kokoro",
        "variantLabel": "Kokoro",
        "language": "Deutsch",
        "quality": "Ausgewogen",
        "requiredBytes": 350_000_000,
        "requiredSizeLabel": "ca. 350 MB",
        "files": (
            ("config.json", f"{KOKORO_REPO_BASE}/config.json?download=true"),
            ("model.pth", f"{KOKORO_REPO_BASE}/model.pth?download=true"),
            ("voices/thorsten.pt", f"{KOKORO_REPO_BASE}/voices/thorsten.pt?download=true"),
        ),
    },
)


class TtsCancelledError(RuntimeError):
    pass


class VoiceDownloadPaused(RuntimeError):
    pass


class VoiceDownloadCancelled(RuntimeError):
    pass


@dataclass(frozen=True)
class VoiceSpec:
    id: str
    name: str
    provider: str
    variantLabel: str
    language: str
    quality: str
    available: bool
    downloaded: bool
    requiredBytes: int
    requiredSizeLabel: str
    downloadState: str
    downloadProgress: int
    downloadMessage: str
    downloadError: str
    downloadBytes: int
    downloadTotalBytes: int
    downloadBytesExact: bool
    isDefault: bool = False
    modelFilename: str = ""
    configFilename: str = ""
    piper_voice_id: str = ""

    def public_dict(self) -> dict[str, Any]:
        return asdict(self)


class TtsEngine:
    def __init__(self, documents_dir: Path, piper_voices_dir: Path, project_root: Path) -> None:
        self.documents_dir = documents_dir
        self.piper_voices_dir = piper_voices_dir
        self.project_root = project_root
        self.models_dir = self.piper_voices_dir.parent / "tts_models"
        self.kokoro_dir = self.models_dir / "kokoro" / "thorsten"

        self._synthesis_lock = threading.RLock()
        self._session_lock = threading.RLock()
        self._download_lock = threading.RLock()
        self._cancelled_sessions: dict[str, float] = {}
        self._active_processes: dict[str, set[subprocess.Popen[str]]] = {}
        self._download_states: dict[str, dict[str, Any]] = {}
        self._download_threads: dict[str, threading.Thread] = {}
        self._download_pause_events: dict[str, threading.Event] = {}
        self._download_cancel_events: dict[str, threading.Event] = {}
        self._active_download_processes: dict[str, subprocess.Popen[str]] = {}
        self._kokoro_runtime: tuple[Any, Any, Any] | None = None
        self.download_state_path = self.models_dir / "download-state.json"

        self.piper_voices_dir.mkdir(parents=True, exist_ok=True)
        self.models_dir.mkdir(parents=True, exist_ok=True)

        self._load_persisted_download_states()

    def _persist_download_states_locked(self) -> None:
        payload = {
            "version": 1,
            "states": self._download_states,
        }

        temp_path = self.download_state_path.with_suffix(".json.tmp")

        try:
            temp_path.parent.mkdir(parents=True, exist_ok=True)
            temp_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            temp_path.replace(self.download_state_path)
        except Exception as error:
            LOGGER.warning(
                "[TTS-Download] Status konnte nicht gespeichert werden: %s",
                error,
            )

    def _load_persisted_download_states(self) -> None:
        if not self.download_state_path.exists():
            return

        try:
            payload = json.loads(
                self.download_state_path.read_text(encoding="utf-8")
            )
            raw_states = payload.get("states", {})

            if not isinstance(raw_states, dict):
                return

            known_ids = {str(entry["id"]) for entry in VOICE_CATALOG}

            with self._download_lock:
                for voice_id, state in raw_states.items():
                    if voice_id not in known_ids or not isinstance(state, dict):
                        continue

                    self._download_states[voice_id] = {
                        "state": str(state.get("state", "idle")),
                        "progress": int(state.get("progress", 0)),
                        "message": str(state.get("message", "")),
                        "error": str(state.get("error", "")),
                        "downloadBytes": int(state.get("downloadBytes", 0)),
                        "downloadTotalBytes": int(state.get("downloadTotalBytes", 0)),
                        "downloadBytesExact": bool(state.get("downloadBytesExact", False)),
                    }

        except Exception as error:
            LOGGER.warning(
                "[TTS-Download] Gespeicherter Status konnte nicht geladen werden: %s",
                error,
            )

    def variant_catalog(self) -> list[dict[str, str]]:
        return [
            {"id": "piper", "label": "Piper"},
            {"id": "kokoro", "label": "Kokoro"},
        ]

    def _catalog_entry(self, voice_id: str) -> dict[str, Any]:
        for entry in VOICE_CATALOG:
            if entry["id"] == voice_id:
                return entry
        raise FileNotFoundError(f"Unbekannte Stimme: {voice_id}")

    def _piper_available(self) -> bool:
        return importlib.util.find_spec("piper") is not None

    def _find_piper_files(self, voice_id: str) -> tuple[Path, Path] | None:
        voice_dir = self.piper_voices_dir / voice_id
        model = voice_dir / f"{voice_id}.onnx"
        config = voice_dir / f"{voice_id}.onnx.json"
        if model.exists() and config.exists():
            return model, config

        root_model = self.project_root / f"{voice_id}.onnx"
        root_config = self.project_root / f"{voice_id}.onnx.json"
        if root_model.exists() and root_config.exists():
            return root_model, root_config
        return None

    def _kokoro_downloaded(self) -> bool:
        return all(
            path.exists()
            for path in (
                self.kokoro_dir / "config.json",
                self.kokoro_dir / "model.pth",
                self.kokoro_dir / "voices" / "thorsten.pt",
            )
        )

    def _downloaded_for_entry(self, entry: dict[str, Any]) -> bool:
        provider = str(entry["provider"])
        if provider == "piper":
            return self._find_piper_files(str(entry["piperVoiceId"])) is not None
        if provider == "kokoro":
            return self._kokoro_downloaded()
        return False

    def _download_state_for(self, voice_id: str, downloaded: bool) -> dict[str, Any]:
        with self._download_lock:
            state = self._download_states.get(voice_id)
            if state is not None:
                return dict(state)

        entry = self._catalog_entry(voice_id)
        total_bytes = int(entry.get("requiredBytes", 0) or 0)

        return {
            "state": "ready" if downloaded else "idle",
            "progress": 100 if downloaded else 0,
            "message": "Installiert" if downloaded else "",
            "error": "",
            "downloadBytes": total_bytes if downloaded else 0,
            "downloadTotalBytes": total_bytes,
            "downloadBytesExact": bool(downloaded),
        }

    def voice_specs(self) -> list[VoiceSpec]:
        specs: list[VoiceSpec] = []

        for entry in VOICE_CATALOG:
            downloaded = self._downloaded_for_entry(entry)
            state = self._download_state_for(str(entry["id"]), downloaded)
            piper_files = None
            if entry["provider"] == "piper":
                piper_files = self._find_piper_files(str(entry["piperVoiceId"]))

            specs.append(
                VoiceSpec(
                    id=str(entry["id"]),
                    name=str(entry["name"]),
                    provider=str(entry["provider"]),
                    variantLabel=str(entry["variantLabel"]),
                    language=str(entry["language"]),
                    quality=str(entry["quality"]),
                    available=downloaded,
                    downloaded=downloaded,
                    requiredBytes=int(entry["requiredBytes"]),
                    requiredSizeLabel=str(entry["requiredSizeLabel"]),
                    downloadState=str(state["state"]),
                    downloadProgress=int(state["progress"]),
                    downloadMessage=str(state["message"]),
                    downloadError=str(state["error"]),
                    downloadBytes=int(state.get("downloadBytes", 0)),
                    downloadTotalBytes=int(state.get("downloadTotalBytes", entry["requiredBytes"])),
                    downloadBytesExact=bool(state.get("downloadBytesExact", False)),
                    isDefault=str(entry["id"]) == DEFAULT_VOICE_ID,
                    modelFilename=piper_files[0].name if piper_files else "",
                    configFilename=piper_files[1].name if piper_files else "",
                    piper_voice_id=str(entry.get("piperVoiceId", "")),
                )
            )

        return specs

    def default_voice_id(self) -> str:
        specs = self.voice_specs()
        default = next(
            (spec for spec in specs if spec.id == DEFAULT_VOICE_ID and spec.available),
            None,
        )
        if default is not None:
            return default.id
        first = next((spec for spec in specs if spec.available), None)
        return first.id if first is not None else DEFAULT_VOICE_ID

    def _spec_by_id(self, voice_id: str) -> VoiceSpec:
        for spec in self.voice_specs():
            if spec.id == voice_id:
                return spec
        raise FileNotFoundError(f"Unbekannte TTS-Stimme: {voice_id}")

    def _set_download_state(
        self,
        voice_id: str,
        state: str,
        progress: int,
        message: str = "",
        error: str = "",
        *,
        download_bytes: int | None = None,
        total_bytes: int | None = None,
        bytes_exact: bool | None = None,
    ) -> None:
        normalized_progress = max(0, min(100, int(progress)))
        catalog_total = int(self._catalog_entry(voice_id).get("requiredBytes", 0) or 0)

        with self._download_lock:
            previous = self._download_states.get(voice_id, {})
            effective_total = int(
                total_bytes
                if total_bytes is not None
                else previous.get("downloadTotalBytes", catalog_total)
            )
            effective_bytes = int(
                download_bytes
                if download_bytes is not None
                else previous.get("downloadBytes", 0)
            )
            effective_exact = bool(
                bytes_exact
                if bytes_exact is not None
                else previous.get("downloadBytesExact", False)
            )

            self._download_states[voice_id] = {
                "state": state,
                "progress": normalized_progress,
                "message": message,
                "error": error,
                "downloadBytes": max(0, effective_bytes),
                "downloadTotalBytes": max(0, effective_total),
                "downloadBytesExact": effective_exact,
            }

            self._persist_download_states_locked()

        if state == "error":
            LOGGER.error("[TTS-Download] %s | %s", voice_id, error or message)

    def _download_control_event(
        self,
        mapping: dict[str, threading.Event],
        voice_id: str,
    ) -> threading.Event:
        with self._download_lock:
            event = mapping.get(voice_id)
            if event is None:
                event = threading.Event()
                mapping[voice_id] = event
            return event

    def _check_download_control(self, voice_id: str) -> None:
        cancel_event = self._download_control_event(self._download_cancel_events, voice_id)
        pause_event = self._download_control_event(self._download_pause_events, voice_id)

        if cancel_event.is_set():
            raise VoiceDownloadCancelled("Download wurde beendet.")
        if pause_event.is_set():
            raise VoiceDownloadPaused("Download wurde pausiert.")

    def _set_active_download_process(
        self,
        voice_id: str,
        process: subprocess.Popen[str] | None,
    ) -> None:
        with self._download_lock:
            if process is None:
                self._active_download_processes.pop(voice_id, None)
            else:
                self._active_download_processes[voice_id] = process

    def _terminate_active_download_process(self, voice_id: str) -> None:
        with self._download_lock:
            process = self._active_download_processes.get(voice_id)

        if process is None or process.poll() is not None:
            return

        try:
            process.terminate()
            process.wait(timeout=1.5)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass

    def _start_download_thread(self, voice_id: str) -> None:
        with self._download_lock:
            existing = self._download_threads.get(voice_id)
            if existing is not None and existing.is_alive():
                return

            thread = threading.Thread(
                target=self._download_voice_worker,
                args=(voice_id,),
                daemon=True,
                name=f"smartvoice-download-{voice_id}",
            )
            self._download_threads[voice_id] = thread

        thread.start()

    def _cleanup_partial_download(self, voice_id: str) -> None:
        entry = self._catalog_entry(voice_id)
        provider = str(entry["provider"])

        if provider == "piper":
            base_dir = self.piper_voices_dir / str(entry["piperVoiceId"])
        elif provider == "kokoro":
            base_dir = self.kokoro_dir
        else:
            base_dir = None

        if base_dir is not None and base_dir.exists():
            for partial in base_dir.rglob("*.part"):
                partial.unlink(missing_ok=True)

    def pause_voice_download(self, voice_id: str) -> dict[str, Any]:
        self._catalog_entry(voice_id)
        current = self._download_state_for(voice_id, False)

        if current.get("state") != "downloading":
            return self.download_status(voice_id)

        self._download_control_event(self._download_pause_events, voice_id).set()
        self._terminate_active_download_process(voice_id)


        self._set_download_state(
            voice_id,
            "paused",
            int(current.get("progress", 0)),
            "Pausiert",
            download_bytes=int(current.get("downloadBytes", 0)),
            total_bytes=int(current.get("downloadTotalBytes", 0)),
            bytes_exact=bool(current.get("downloadBytesExact", False)),
        )
        return self.download_status(voice_id)

    def resume_voice_download(self, voice_id: str) -> dict[str, Any]:
        entry = self._catalog_entry(voice_id)
        current = self._download_state_for(voice_id, self._downloaded_for_entry(entry))

        if current.get("state") != "paused":
            return self.download_status(voice_id)

        self._download_control_event(self._download_cancel_events, voice_id).clear()
        self._download_control_event(self._download_pause_events, voice_id).clear()
        total_bytes = int(
            current.get("downloadTotalBytes", entry.get("requiredBytes", 0))
        )

        self._set_download_state(
            voice_id,
            "downloading",
            int(current.get("progress", 0)),
            "Download wird fortgesetzt",
            download_bytes=int(current.get("downloadBytes", 0)),
            total_bytes=total_bytes,
            bytes_exact=True,
        )
        self._start_download_thread(voice_id)
        return self.download_status(voice_id)

    def cancel_voice_download(self, voice_id: str) -> dict[str, Any]:
        entry = self._catalog_entry(voice_id)
        self._download_control_event(self._download_cancel_events, voice_id).set()
        self._download_control_event(self._download_pause_events, voice_id).clear()
        self._terminate_active_download_process(voice_id)

        with self._download_lock:
            thread = self._download_threads.get(voice_id)

        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2.0)

        self._cleanup_partial_download(voice_id)
        self._set_download_state(
            voice_id,
            "idle",
            0,
            "Download beendet",
            download_bytes=0,
            total_bytes=int(entry.get("requiredBytes", 0)),
            bytes_exact=False,
        )
        return self.download_status(voice_id)

    @staticmethod
    def _format_download_size(value: int) -> str:
        size = float(max(0, value))

        for unit in ("B", "KB", "MB", "GB"):
            if size < 1024.0 or unit == "GB":
                if unit == "B":
                    return f"{int(size)} {unit}"
                return f"{size:.1f} {unit}"
            size /= 1024.0

        return f"{size:.1f} GB"

    def _remote_content_length(self, url: str) -> int | None:
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "SmartVoice/1.0"},
            method="HEAD",
        )

        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                value = response.headers.get("Content-Length")

                if not value:
                    return None

                length = int(value)
                return length if length > 0 else None
        except Exception:
            return None

    def start_voice_download(self, voice_id: str) -> dict[str, Any]:
        entry = self._catalog_entry(voice_id)

        if self._downloaded_for_entry(entry):
            total_bytes = int(entry.get("requiredBytes", 0))
            self._set_download_state(
                voice_id,
                "ready",
                100,
                "Installiert",
                download_bytes=total_bytes,
                total_bytes=total_bytes,
                bytes_exact=True,
            )
            return self.download_status(voice_id)

        with self._download_lock:
            current = self._download_states.get(voice_id)
            if current and current.get("state") in {"downloading", "paused"}:
                return self.download_status(voice_id)

        self._download_control_event(self._download_pause_events, voice_id).clear()
        self._download_control_event(self._download_cancel_events, voice_id).clear()

        total_bytes = int(entry.get("requiredBytes", 0))
        self._set_download_state(
            voice_id,
            "downloading",
            0,
            "Download wird vorbereitet",
            download_bytes=0,
            total_bytes=total_bytes,
            bytes_exact=True,
        )

        self._start_download_thread(voice_id)
        return self.download_status(voice_id)

    def download_status(self, voice_id: str) -> dict[str, Any]:
        return self._spec_by_id(voice_id).public_dict()

    def _download_voice_worker(self, voice_id: str) -> None:
        try:
            entry = self._catalog_entry(voice_id)
            provider = str(entry["provider"])
            self._check_download_control(voice_id)

            if provider == "piper":
                self._download_piper(entry)
            elif provider == "kokoro":
                self._download_kokoro(entry)
            else:
                raise RuntimeError(f"Unbekannter Provider: {provider}")

            total_bytes = int(entry.get("requiredBytes", 0))
            self._set_download_state(
                voice_id,
                "ready",
                100,
                "Installiert",
                download_bytes=total_bytes,
                total_bytes=total_bytes,
                bytes_exact=True,
            )
        except VoiceDownloadPaused:
            current = self._download_state_for(voice_id, False)
            self._set_download_state(
                voice_id,
                "paused",
                int(current.get("progress", 0)),
                "Pausiert",
                download_bytes=int(current.get("downloadBytes", 0)),
                total_bytes=int(current.get("downloadTotalBytes", 0)),
                bytes_exact=bool(current.get("downloadBytesExact", False)),
            )
        except VoiceDownloadCancelled:
            self._cleanup_partial_download(voice_id)
            entry = self._catalog_entry(voice_id)
            self._set_download_state(
                voice_id,
                "idle",
                0,
                "Download beendet",
                download_bytes=0,
                total_bytes=int(entry.get("requiredBytes", 0)),
                bytes_exact=False,
            )
        except Exception as error:
            current = self._download_state_for(voice_id, False)
            self._set_download_state(
                voice_id,
                "error",
                int(current.get("progress", 0)),
                "Download fehlgeschlagen",
                str(error),
                download_bytes=int(current.get("downloadBytes", 0)),
                total_bytes=int(current.get("downloadTotalBytes", 0)),
                bytes_exact=bool(current.get("downloadBytesExact", False)),
            )
        finally:
            self._set_active_download_process(voice_id, None)
            with self._download_lock:
                current_thread = self._download_threads.get(voice_id)
                if current_thread is threading.current_thread():
                    self._download_threads.pop(voice_id, None)

    def _download_http_files(
        self,
        voice_id: str,
        files: tuple[tuple[str, str], ...],
        target_dir: Path,
        start_progress: int,
        end_progress: int,
        expected_total_bytes: int | None = None,
    ) -> None:
        target_dir.mkdir(parents=True, exist_ok=True)

        remote_sizes: dict[str, int] = {}
        total_remote_bytes = 0

        for relative_name, url in files:
            remote_size = self._remote_content_length(url)

            if remote_size is not None:
                remote_sizes[relative_name] = remote_size
                total_remote_bytes += remote_size

        total_expected_bytes = (
            total_remote_bytes
            if total_remote_bytes > 0
            else max(1, int(expected_total_bytes or 1))
        )

        completed_bytes = 0

        for relative_name, _ in files:
            target = target_dir / relative_name

            if target.exists() and target.stat().st_size > 0:
                completed_bytes += remote_sizes.get(
                    relative_name,
                    target.stat().st_size,
                )

        last_ui_update = 0.0

        for relative_name, url in files:
            self._check_download_control(voice_id)
            target = target_dir / relative_name
            target.parent.mkdir(parents=True, exist_ok=True)

            expected_file_bytes = remote_sizes.get(relative_name)

            if (
                target.exists()
                and target.stat().st_size > 0
                and (
                    expected_file_bytes is None
                    or target.stat().st_size >= expected_file_bytes
                )
            ):
                continue

            temp = Path(str(target) + ".part")
            existing_partial = temp.stat().st_size if temp.exists() else 0

            headers = {"User-Agent": "SmartVoice/1.0"}

            if existing_partial > 0:
                headers["Range"] = f"bytes={existing_partial}-"

            request = urllib.request.Request(url, headers=headers)

            with urllib.request.urlopen(request, timeout=60) as response:
                status = getattr(response, "status", 200)

                if existing_partial > 0 and status != 206:
                    temp.unlink(missing_ok=True)
                    existing_partial = 0

                response_length = int(
                    response.headers.get("Content-Length", "0") or "0"
                )

                if expected_file_bytes is None and response_length > 0:
                    expected_file_bytes = (
                        existing_partial + response_length
                        if status == 206
                        else response_length
                    )

                mode = "ab" if existing_partial > 0 and status == 206 else "wb"
                received_for_file = existing_partial

                with open(temp, mode) as handle:
                    while True:
                        self._check_download_control(voice_id)
                        chunk = response.read(256 * 1024)

                        if not chunk:
                            break

                        handle.write(chunk)
                        received_for_file += len(chunk)

                        downloaded_bytes = completed_bytes + received_for_file
                        ratio = min(
                            1.0,
                            downloaded_bytes / total_expected_bytes,
                        )
                        progress = start_progress + round(
                            ratio * (end_progress - start_progress)
                        )

                        now = time.monotonic()

                        if now - last_ui_update >= 0.15:
                            last_ui_update = now
                            self._set_download_state(
                                voice_id,
                                "downloading",
                                progress,
                                f"Lade {Path(relative_name).name}",
                                download_bytes=downloaded_bytes,
                                total_bytes=total_expected_bytes,
                                bytes_exact=True,
                            )

            temp.replace(target)

            actual_file_bytes = target.stat().st_size
            completed_bytes += (
                expected_file_bytes
                if expected_file_bytes is not None
                else actual_file_bytes
            )

            progress = start_progress + round(
                min(1.0, completed_bytes / total_expected_bytes)
                * (end_progress - start_progress)
            )

            self._set_download_state(
                voice_id,
                "downloading",
                progress,
                f"{Path(relative_name).name} abgeschlossen",
                download_bytes=completed_bytes,
                total_bytes=total_expected_bytes,
                bytes_exact=True,
            )

    def _download_piper(self, entry: dict[str, Any]) -> None:
        voice_id = str(entry["id"])
        target_dir = self.piper_voices_dir / str(entry["piperVoiceId"])
        self._download_http_files(
            voice_id,
            tuple(entry["files"]),
            target_dir,
            3,
            99,
            expected_total_bytes=int(entry["requiredBytes"]),
        )

    def _run_download_process(
        self,
        voice_id: str,
        command: list[str],
        *,
        line_handler: Any | None = None,
    ) -> tuple[int, str]:
        self._check_download_control(voice_id)
        process = subprocess.Popen(
            command,
            cwd=str(self.project_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self._set_active_download_process(voice_id, process)
        lines: list[str] = []

        try:
            if process.stdout is not None:
                for raw_line in process.stdout:
                    self._check_download_control(voice_id)
                    line = raw_line.rstrip()
                    if line:
                        lines.append(line)
                        if len(lines) > 120:
                            lines.pop(0)
                        if line_handler is not None:
                            line_handler(line)

            return_code = process.wait()
            self._check_download_control(voice_id)
            return return_code, "\n".join(lines)
        finally:
            self._set_active_download_process(voice_id, None)

    def _run_install(self, voice_id: str, command: list[str], message: str, progress: int) -> None:
        entry = self._catalog_entry(voice_id)
        total_bytes = int(entry.get("requiredBytes", 0))
        estimated_bytes = round(total_bytes * max(0, min(100, progress)) / 100)
        self._set_download_state(
            voice_id,
            "downloading",
            progress,
            message,
            download_bytes=estimated_bytes,
            total_bytes=total_bytes,
            bytes_exact=False,
        )
        return_code, output = self._run_download_process(voice_id, command)
        if return_code != 0:
            raise RuntimeError(output[-3000:] if output else f"{message} fehlgeschlagen.")

    def _ensure_kokoro_runtime(self, voice_id: str) -> None:
        basic = {
            "huggingface_hub": "huggingface_hub",
            "soundfile": "soundfile",
            "numpy": "numpy",
            "torch": "torch",
        }
        missing_packages = [
            package
            for module, package in basic.items()
            if importlib.util.find_spec(module) is None
        ]
        if missing_packages:
            self._run_install(
                voice_id,
                [sys.executable, "-m", "pip", "install", *missing_packages],
                "Installiere Kokoro-Laufzeit",
                4,
            )

        if importlib.util.find_spec("misaki") is None:
            self._run_install(
                voice_id,
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "git+https://github.com/semidark/misaki.git@6d252a2e02f3b030f22f56686f1a73786c16ffc8",
                ],
                "Installiere deutsche Aussprache",
                6,
            )

        if importlib.util.find_spec("kokoro") is None:
            self._run_install(
                voice_id,
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "git+https://github.com/semidark/kokoro.git",
                ],
                "Installiere Kokoro",
                8,
            )
        importlib.invalidate_caches()

    def _download_kokoro(self, entry: dict[str, Any]) -> None:
        voice_id = str(entry["id"])
        self._ensure_kokoro_runtime(voice_id)
        self._download_http_files(
            voice_id,
            tuple(entry["files"]),
            self.kokoro_dir,
            10,
            99,
            expected_total_bytes=int(entry["requiredBytes"]),
        )

    def _prune_cancelled_sessions_locked(self) -> None:
        cutoff = time.monotonic() - 600
        for session_id in [
            key for key, timestamp in self._cancelled_sessions.items()
            if timestamp < cutoff
        ]:
            self._cancelled_sessions.pop(session_id, None)

    def is_session_cancelled(self, session_id: str | None) -> bool:
        if not session_id:
            return False
        with self._session_lock:
            self._prune_cancelled_sessions_locked()
            return session_id in self._cancelled_sessions

    def _check_session(self, session_id: str | None) -> None:
        if self.is_session_cancelled(session_id):
            raise TtsCancelledError("TTS-Generierung wurde abgebrochen.")

    def _register_process(self, session_id: str | None, process: subprocess.Popen[str]) -> None:
        if not session_id:
            return
        with self._session_lock:
            if session_id in self._cancelled_sessions:
                process.terminate()
                raise TtsCancelledError("TTS-Generierung wurde abgebrochen.")
            self._active_processes.setdefault(session_id, set()).add(process)

    def _unregister_process(self, session_id: str | None, process: subprocess.Popen[str]) -> None:
        if not session_id:
            return
        with self._session_lock:
            processes = self._active_processes.get(session_id)
            if processes is None:
                return
            processes.discard(process)
            if not processes:
                self._active_processes.pop(session_id, None)

    def cancel_session(self, session_id: str) -> dict[str, Any]:
        clean = session_id.strip()
        if not clean:
            return {"sessionId": session_id, "cancelled": False, "terminatedProcesses": 0}

        with self._session_lock:
            self._cancelled_sessions[clean] = time.monotonic()
            processes = list(self._active_processes.get(clean, set()))

        terminated = 0
        for process in processes:
            if process.poll() is None:
                try:
                    process.terminate()
                    terminated += 1
                except Exception:
                    pass

        return {
            "sessionId": clean,
            "cancelled": True,
            "terminatedProcesses": terminated,
        }

    def _run_cancellable_process(
        self,
        args: list[str],
        session_id: str | None,
        input_text: str | None = None,
        timeout: float | None = None,
    ) -> tuple[int, str, str]:
        self._check_session(session_id)
        process = subprocess.Popen(
            args,
            stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self._register_process(session_id, process)
        try:
            stdout, stderr = process.communicate(input=input_text, timeout=timeout)
        finally:
            self._unregister_process(session_id, process)
        self._check_session(session_id)
        return process.returncode, stdout, stderr

    def _safe_component(self, value: str) -> str:
        return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-") or "default"

    def _cache_path(
        self,
        document_id: str,
        chunk_id: str,
        spec: VoiceSpec,
        text: str,
    ) -> tuple[Path, str]:
        signature = "\n".join([CACHE_VERSION, spec.id, text])
        digest = hashlib.sha256(signature.encode("utf-8")).hexdigest()[:16]
        voice_component = self._safe_component(spec.id)
        filename = f"{self._safe_component(chunk_id)}_{digest}.wav"
        path = (
            self.documents_dir
            / document_id
            / "audio"
            / spec.provider
            / voice_component
            / "chunks"
            / filename
        )
        url = (
            f"/documents/{document_id}/audio/"
            f"{spec.provider}/{voice_component}/chunks/{filename}"
        )
        return path, url

    def _wav_duration(self, path: Path) -> float:
        with wave.open(str(path), "rb") as wav_file:
            rate = wav_file.getframerate()
            return wav_file.getnframes() / float(rate) if rate > 0 else 0.0

    def _valid_wav_file(self, path: Path) -> bool:
        if not path.exists() or path.stat().st_size <= 44:
            return False
        try:
            with wave.open(str(path), "rb") as wav_file:
                return wav_file.getframerate() > 0 and wav_file.getnframes() > 0
        except (wave.Error, EOFError, OSError):
            return False

    def _sanitize_piper_text(self, text: str) -> str:
        value = unicodedata.normalize("NFKC", str(text))
        for source, target in {
            "\u00ad": "",
            "\u200b": "",
            "\u200c": "",
            "\u200d": "",
            "\ufeff": "",
            "–": "-",
            "—": "-",
            "−": "-",
            "…": "...",
            "“": '"',
            "”": '"',
            "„": '"',
            "‘": "'",
            "’": "'",
            "•": " ",
            "·": " ",
            "→": " ",
            "←": " ",
            "×": " mal ",
            "÷": " geteilt durch ",
            "&": " und ",
        }.items():
            value = value.replace(source, target)

        value = "".join(
            char
            if char.isspace()
            or unicodedata.category(char).startswith(("L", "N", "M"))
            or char in '.,;:!?()[]{}"\'-/'
            else " "
            for char in value
        )
        value = re.sub(r"\s+", " ", value)
        value = re.sub(r"\s+([,.;:!?])", r"\1", value).strip()
        return value if any(char.isalnum() for char in value) else ""

    def _synthesize_piper(
        self,
        spec: VoiceSpec,
        text: str,
        output_path: Path,
        session_id: str | None,
    ) -> None:
        if not self._piper_available():
            raise RuntimeError("Piper ist nicht installiert.")
        files = self._find_piper_files(spec.piper_voice_id)
        if files is None:
            raise FileNotFoundError(f"Piper-Modell fehlt: {spec.id}")

        model_path, config_path = files
        safe_text = self._sanitize_piper_text(text)
        if not safe_text:
            raise ValueError("Piper-TTS-Text enthält keinen sprechbaren Inhalt.")

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.unlink(missing_ok=True)
        returncode, stdout, stderr = self._run_cancellable_process(
            [
                sys.executable,
                "-m",
                "piper",
                "-m",
                str(model_path),
                "-c",
                str(config_path),
                "-f",
                str(output_path),
            ],
            session_id,
            safe_text,
        )
        if returncode != 0 or not self._valid_wav_file(output_path):
            output_path.unlink(missing_ok=True)
            raise RuntimeError(stderr.strip() or stdout.strip() or "Piper hat kein Audio erzeugt.")

    def _load_kokoro_runtime(self) -> tuple[Any, Any, Any]:
        if self._kokoro_runtime is not None:
            return self._kokoro_runtime
        if not self._kokoro_downloaded():
            raise FileNotFoundError("Kokoro ist noch nicht heruntergeladen.")

        importlib.invalidate_caches()
        try:
            import numpy as np
            import torch
            from kokoro import KModel, KPipeline
        except Exception as error:
            raise RuntimeError("Kokoro-Laufzeit ist nicht vollständig installiert.") from error

        model = KModel(
            repo_id="hexgrad/Kokoro-82M",
            config=str(self.kokoro_dir / "config.json"),
            model=str(self.kokoro_dir / "model.pth"),
        ).to("cpu").eval()

        pipeline = KPipeline(
            lang_code="d",
            repo_id="hexgrad/Kokoro-82M",
            model=model,
        )
        original_g2p = pipeline.g2p

        def german_g2p(text: str) -> tuple[str, Any]:
            phonemes, tokens = original_g2p(text)
            return phonemes.replace("ʏ", "y"), tokens

        pipeline.g2p = german_g2p
        voice = torch.load(
            self.kokoro_dir / "voices" / "thorsten.pt",
            map_location="cpu",
            weights_only=True,
        )
        self._kokoro_runtime = (pipeline, voice, np)
        return self._kokoro_runtime

    def _synthesize_kokoro(
        self,
        text: str,
        output_path: Path,
        session_id: str | None,
    ) -> None:
        self._check_session(session_id)
        pipeline, voice, np = self._load_kokoro_runtime()
        import soundfile as sf

        chunks = [
            audio
            for _, _, audio in pipeline(text, voice=voice, speed=1.0)
        ]
        self._check_session(session_id)
        if not chunks:
            raise RuntimeError("Kokoro hat kein Audio erzeugt.")

        output_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output_path), np.concatenate(chunks), 24000)

    def _synthesize_with_spec(
        self,
        document_id: str,
        chunk_id: str,
        text: str,
        spec: VoiceSpec,
        session_id: str | None,
    ) -> dict[str, Any]:
        self._check_session(session_id)
        normalized = normalize_german_tts_text(text)
        if not normalized:
            raise ValueError("TTS-Text ist leer.")
        if not spec.downloaded:
            raise FileNotFoundError(f"{spec.variantLabel} wurde noch nicht heruntergeladen.")

        output_path, audio_url = self._cache_path(
            document_id,
            chunk_id,
            spec,
            normalized,
        )
        if output_path.exists() and self._valid_wav_file(output_path):
            return {
                "voiceId": spec.id,
                "provider": spec.provider,
                "audioUrl": audio_url,
                "duration": round(self._wav_duration(output_path), 3),
                "cached": True,
                "normalizedText": normalized,
            }

        with self._synthesis_lock:
            if spec.provider == "piper":
                self._synthesize_piper(spec, normalized, output_path, session_id)
            elif spec.provider == "kokoro":
                self._synthesize_kokoro(normalized, output_path, session_id)
            else:
                raise RuntimeError(f"Unbekannter Provider: {spec.provider}")

        return {
            "voiceId": spec.id,
            "provider": spec.provider,
            "audioUrl": audio_url,
            "duration": round(self._wav_duration(output_path), 3),
            "cached": False,
            "normalizedText": normalized,
        }

    def synthesize_chunk(
        self,
        document_id: str,
        chunk_id: str,
        text: str,
        requested_voice_id: str,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        requested = self._spec_by_id(requested_voice_id)
        if not requested.downloaded:
            raise FileNotFoundError(f"{requested.variantLabel} wurde noch nicht heruntergeladen.")

        candidates = [requested]
        if requested.provider == "piper":
            candidates.extend(
                spec
                for spec in self.voice_specs()
                if spec.provider == "piper"
                and spec.id != requested.id
                and spec.available
            )

        errors: list[str] = []
        for spec in candidates:
            try:
                result = self._synthesize_with_spec(
                    document_id,
                    chunk_id,
                    text,
                    spec,
                    session_id,
                )
                result["requestedVoiceId"] = requested.id
                result["fallbackUsed"] = spec.id != requested.id
                result["fallbackErrors"] = errors
                return result
            except TtsCancelledError:
                raise
            except Exception as error:
                errors.append(f"{spec.id}: {error}")

        raise RuntimeError("Keine Stimme konnte Audio erzeugen. " + " | ".join(errors))
