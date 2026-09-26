from __future__ import annotations

import http.server
import os
import socketserver
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn


BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8001

FRONTEND_HOST = "127.0.0.1"
FRONTEND_PORT = 5173


def resource_path(relative_path: str) -> Path:
    if getattr(sys, "frozen", False):
        base_path = Path(sys._MEIPASS)
    else:
        base_path = Path(__file__).resolve().parent

    return base_path / relative_path


def application_support_dir() -> Path:
    path = (
        Path.home()
        / "Library"
        / "Application Support"
        / "SmartVoice"
    )

    path.mkdir(
        parents=True,
        exist_ok=True,
    )

    return path


class FrontendRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(
            *args,
            directory=str(resource_path("frontend/dist")),
            **kwargs,
        )

    def do_GET(self) -> None:
        requested_path = self.path.split("?", 1)[0]

        if requested_path == "/":
            return super().do_GET()

        relative_path = requested_path.lstrip("/")
        absolute_path = resource_path(
            f"frontend/dist/{relative_path}"
        )

        if absolute_path.exists():
            return super().do_GET()

        self.path = "/index.html"
        return super().do_GET()

    def log_message(self, format: str, *args) -> None:
        return


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_frontend_server() -> None:
    with ReusableTCPServer(
        (FRONTEND_HOST, FRONTEND_PORT),
        FrontendRequestHandler,
    ) as server:
        server.serve_forever()


def start_backend_server() -> None:
    backend_dir = resource_path("backend")

    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))

    os.environ["SMARTVOICE_DATA_DIR"] = str(
        application_support_dir()
    )

    from main import app

    uvicorn.run(
        app,
        host=BACKEND_HOST,
        port=BACKEND_PORT,
        log_level="warning",
        access_log=False,
    )


def main() -> None:
    frontend_thread = threading.Thread(
        target=start_frontend_server,
        daemon=True,
    )

    backend_thread = threading.Thread(
        target=start_backend_server,
        daemon=True,
    )

    backend_thread.start()
    frontend_thread.start()

    time.sleep(1.5)

    webbrowser.open(
        f"http://{FRONTEND_HOST}:{FRONTEND_PORT}"
    )

    try:
        while (
            backend_thread.is_alive()
            and frontend_thread.is_alive()
        ):
            time.sleep(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()