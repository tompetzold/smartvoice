import os
import signal
import subprocess
import sys
import time
import webbrowser
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ROOT_DIR / "backend"
FRONTEND_DIR = ROOT_DIR / "frontend"

BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = "8000"
FRONTEND_URL = "http://localhost:5173"

BACKEND_COMMAND = [
    sys.executable,
    "-m",
    "uvicorn",
    "main:app",
    "--reload",
    "--host",
    BACKEND_HOST,
    "--port",
    BACKEND_PORT,
]

FRONTEND_COMMAND = ["npm", "run", "dev"]


def ensure_paths_exist() -> None:
    missing_paths = []

    if not BACKEND_DIR.exists():
        missing_paths.append(str(BACKEND_DIR))

    if not FRONTEND_DIR.exists():
        missing_paths.append(str(FRONTEND_DIR))

    if not (BACKEND_DIR / "main.py").exists():
        missing_paths.append(str(BACKEND_DIR / "main.py"))

    if not (FRONTEND_DIR / "package.json").exists():
        missing_paths.append(str(FRONTEND_DIR / "package.json"))

    if missing_paths:
        joined = "\n".join(missing_paths)
        raise RuntimeError(f"Diese Projektpfade fehlen:\n{joined}")


def start_process(name: str, command: list[str], cwd: Path) -> subprocess.Popen:
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"

    print(f"[{name}] Starte: {' '.join(command)}")
    print(f"[{name}] Arbeitsverzeichnis: {cwd}")

    process = subprocess.Popen(
        command,
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )

    return process


def stream_output(name: str, process: subprocess.Popen) -> None:
    if process.stdout is None:
        return

    for line in process.stdout:
        print(f"[{name}] {line}", end="")


def terminate_process(name: str, process: subprocess.Popen | None) -> None:
    if process is None:
        return

    if process.poll() is not None:
        return

    print(f"\n[{name}] Stoppe Prozess ...")

    try:
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except ProcessLookupError:
        return
    except Exception:
        process.terminate()

    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        print(f"[{name}] Prozess reagiert nicht. Erzwinge Kill ...")
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except Exception:
            process.kill()


def main() -> None:
    ensure_paths_exist()

    backend_process: subprocess.Popen | None = None
    frontend_process: subprocess.Popen | None = None

    try:
        backend_process = start_process("backend", BACKEND_COMMAND, BACKEND_DIR)
        time.sleep(1.5)

        frontend_process = start_process("frontend", FRONTEND_COMMAND, FRONTEND_DIR)
        time.sleep(2.5)

        print(f"\nVoiceMaster läuft:")
        print(f"Frontend: {FRONTEND_URL}")
        print(f"Backend:  http://{BACKEND_HOST}:{BACKEND_PORT}")
        print("\nBeenden mit CTRL+C.\n")

        webbrowser.open(FRONTEND_URL)

        import threading

        backend_thread = threading.Thread(
            target=stream_output,
            args=("backend", backend_process),
            daemon=True,
        )
        frontend_thread = threading.Thread(
            target=stream_output,
            args=("frontend", frontend_process),
            daemon=True,
        )

        backend_thread.start()
        frontend_thread.start()

        while True:
            backend_code = backend_process.poll()
            frontend_code = frontend_process.poll()

            if backend_code is not None:
                raise RuntimeError(f"Backend wurde beendet. Exit-Code: {backend_code}")

            if frontend_code is not None:
                raise RuntimeError(f"Frontend wurde beendet. Exit-Code: {frontend_code}")

            time.sleep(0.5)

    except KeyboardInterrupt:
        print("\nBeende VoiceMaster ...")
    finally:
        terminate_process("frontend", frontend_process)
        terminate_process("backend", backend_process)
        print("Gestoppt.")


if __name__ == "__main__":
    main()