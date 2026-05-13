from pathlib import Path

import gradio as gr
import torch
from TTS.api import TTS


MODEL_NAME = "tts_models/multilingual/multi-dataset/xtts_v2"
OUTPUT_DIR = Path("outputs")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


class LocalVoiceCloneApp:
    def __init__(self) -> None:
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Using device: {self.device}")
        self.tts = TTS(MODEL_NAME).to(self.device)

    def synthesize(self, text: str, speaker_wav_path: str, language: str) -> str:
        if text is None or not text.strip():
            raise gr.Error("Textfeld ist leer.")

        if speaker_wav_path is None or not str(speaker_wav_path).strip():
            raise gr.Error("Du musst eine Referenzaufnahme deiner Stimme hochladen oder aufnehmen.")

        speaker_path = Path(speaker_wav_path)

        if not speaker_path.exists():
            raise gr.Error(f"Referenz-Audio existiert nicht: {speaker_path}")

        normalized_text = self.normalize_text(text)

        output_path = OUTPUT_DIR / "output.wav"

        self.tts.tts_to_file(
            text=normalized_text,
            speaker_wav=str(speaker_path),
            language=language,
            file_path=str(output_path),
        )

        return str(output_path)

    @staticmethod
    def normalize_text(text: str) -> str:
        replacements = {
            " KI ": " künstliche Intelligenz ",
            " AI ": " Artificial Intelligence ",
            " ML ": " Machine Learning ",
            " LLM ": " Large Language Model ",
            " PDF ": " P D F ",
            " OCR ": " O C R ",
            " TTS ": " Text to Speech ",
        }

        normalized = f" {text.strip()} "

        for source, target in replacements.items():
            normalized = normalized.replace(source, target)

        return normalized.strip()


app = LocalVoiceCloneApp()


with gr.Blocks(title="Lokaler TTS Voice Clone") as demo:
    gr.Markdown("# Lokaler TTS Voice Clone")
    gr.Markdown("Text eingeben, Referenzaufnahme deiner Stimme hochladen oder aufnehmen, Audio generieren.")

    with gr.Row():
        with gr.Column():
            text_input = gr.Textbox(
                label="Text",
                value="Hallo, das ist ein lokaler Test. Ich möchte prüfen, ob diese Stimme auf Deutsch natürlich klingt.",
                lines=8,
            )

            speaker_input = gr.Audio(
                label="Referenz-Audio deiner Stimme",
                sources=["upload", "microphone"],
                type="filepath",
            )

            language_input = gr.Dropdown(
                label="Sprache",
                choices=[
                    "de",
                    "en",
                    "fr",
                    "es",
                    "it",
                    "pt",
                    "pl",
                    "tr",
                    "ru",
                    "nl",
                    "cs",
                    "ar",
                    "zh-cn",
                    "ja",
                    "ko",
                    "hu",
                ],
                value="de",
            )

            generate_button = gr.Button("Generate / Play", variant="primary")

        with gr.Column():
            audio_output = gr.Audio(
                label="Generiertes Audio",
                type="filepath",
                autoplay=True,
            )

    generate_button.click(
        fn=app.synthesize,
        inputs=[text_input, speaker_input, language_input],
        outputs=audio_output,
    )


if __name__ == "__main__":
    demo.launch(
        server_name="127.0.0.1",
        server_port=7860,
        inbrowser=True,
    )