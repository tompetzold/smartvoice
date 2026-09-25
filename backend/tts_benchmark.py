from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime
from pathlib import Path

from tts_engine import TtsEngine
from tts_text import normalize_german_tts_text


BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
DATA_DIR = BASE_DIR / "data"
DOCUMENTS_DIR = DATA_DIR / "documents"
PIPER_VOICES_DIR = DATA_DIR / "piper_voices"
BENCHMARK_DIR = DATA_DIR / "tts_benchmark"

BENCHMARK_TEXT = """Künstliche Intelligenz verändert derzeit viele Arbeitsprozesse. Entscheidend ist jedoch nicht nur, wie schnell ein System reagiert, sondern ob längere Texte ruhig, verständlich und mit einer glaubwürdigen Satzmelodie vorgelesen werden. Gerade bei wissenschaftlichen Texten müssen Nebensätze, Einschübe und längere Argumentationsketten so betont werden, dass der Zusammenhang erhalten bleibt."""


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Direkter SmartVoice-Hörvergleich für Thorsten High und Medium."
    )
    parser.add_argument(
        "--open",
        action="store_true",
        help="Öffnet den Ergebnisordner nach der Generierung im Finder.",
    )
    parser.add_argument(
        "--text-file",
        type=Path,
        default=None,
        help="Optional: eigener deutscher Testtext als UTF-8-Datei.",
    )
    args = parser.parse_args()

    text = BENCHMARK_TEXT

    if args.text_file is not None:
        text = args.text_file.read_text(encoding="utf-8")

    normalized_text = normalize_german_tts_text(text)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir = BENCHMARK_DIR / timestamp
    output_dir.mkdir(parents=True, exist_ok=True)

    engine = TtsEngine(
        documents_dir=DOCUMENTS_DIR,
        piper_voices_dir=PIPER_VOICES_DIR,
        project_root=PROJECT_ROOT,
    )

    candidates = [
        ("piper:de_DE-thorsten-high", "01-thorsten-high.wav"),
        ("piper:de_DE-thorsten-medium", "02-thorsten-medium.wav"),
    ]

    results: list[dict[str, object]] = []

    for voice_id, filename in candidates:
        output_path = output_dir / filename

        try:
            result = engine.synthesize_benchmark(
                voice_id,
                text,
                output_path,
            )
            result["ok"] = True
            results.append(result)
        except Exception as error:
            results.append(
                {
                    "voiceId": voice_id,
                    "path": str(output_path),
                    "ok": False,
                    "error": str(error),
                }
            )

    manifest = {
        "createdAt": datetime.now().isoformat(),
        "text": text,
        "normalizedText": normalized_text,
        "results": results,
    }

    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            manifest,
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"Ausgabe: {output_dir}")

    for result in results:
        state = "OK" if result.get("ok") else "FEHLER"
        print(
            f"- [{state}] "
            f"{result.get('voiceId')}: "
            f"{result.get('path')}"
        )

    if args.open:
        subprocess.run(
            ["open", str(output_dir)],
            check=False,
        )


if __name__ == "__main__":
    main()
