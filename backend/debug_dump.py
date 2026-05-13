import argparse
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DOCUMENTS_DIR = DATA_DIR / "documents"
DEBUG_DIR = DATA_DIR / "debug"


def load_json(path: Path) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as file:
        return json.load(file)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w", encoding="utf-8") as file:
        file.write(text)


def normalize_spaces(text: str) -> str:
    return " ".join(text.split())


def find_latest_document_metadata() -> Path:
    metadata_paths = list(DOCUMENTS_DIR.glob("*/metadata.json"))

    if not metadata_paths:
        raise FileNotFoundError("Keine metadata.json gefunden. Lade zuerst eine PDF in der App.")

    metadata_paths.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    return metadata_paths[0]


def find_document_metadata(document_id: str) -> Path:
    metadata_path = DOCUMENTS_DIR / document_id / "metadata.json"

    if not metadata_path.exists():
        raise FileNotFoundError(f"Keine metadata.json gefunden für documentId: {document_id}")

    return metadata_path


def group_words_by_page(words: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)

    for word in words:
        grouped[int(word["pageNumber"])].append(word)

    for page_number in grouped:
        grouped[page_number].sort(
            key=lambda word: (
                int(word.get("blockNumber", 0)),
                int(word.get("lineNumber", 0)),
                int(word.get("wordNumber", 0)),
                float(word.get("y0", 0.0)),
                float(word.get("x0", 0.0)),
            )
        )

    return dict(grouped)


def group_words_to_lines(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[int, int, int], list[dict[str, Any]]] = defaultdict(list)

    for word in words:
        key = (
            int(word["pageNumber"]),
            int(word.get("blockNumber", 0)),
            int(word.get("lineNumber", 0)),
        )
        grouped[key].append(word)

    lines: list[dict[str, Any]] = []

    for (page_number, block_number, line_number), line_words in grouped.items():
        line_words.sort(key=lambda word: (float(word.get("x0", 0.0)), int(word.get("wordNumber", 0))))

        text = normalize_spaces(" ".join(str(word["text"]) for word in line_words))
        x0 = min(float(word["x0"]) for word in line_words)
        y0 = min(float(word["y0"]) for word in line_words)
        x1 = max(float(word["x1"]) for word in line_words)
        y1 = max(float(word["y1"]) for word in line_words)

        lines.append(
            {
                "pageNumber": page_number,
                "blockNumber": block_number,
                "lineNumber": line_number,
                "text": text,
                "x0": x0,
                "y0": y0,
                "x1": x1,
                "y1": y1,
                "wordIds": [str(word["id"]) for word in line_words],
                "words": line_words,
            }
        )

    lines.sort(
        key=lambda line: (
            int(line["pageNumber"]),
            int(line["blockNumber"]),
            int(line["lineNumber"]),
            float(line["y0"]),
            float(line["x0"]),
        )
    )

    return lines


def build_word_lookup(words: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(word["id"]): word for word in words}


def format_box_from_word(word: dict[str, Any]) -> str:
    return (
        f"x0={float(word.get('x0', 0.0)):.2f}, "
        f"y0={float(word.get('y0', 0.0)):.2f}, "
        f"x1={float(word.get('x1', 0.0)):.2f}, "
        f"y1={float(word.get('y1', 0.0)):.2f}"
    )


def format_line_box(line: dict[str, Any]) -> str:
    return (
        f"x0={float(line.get('x0', 0.0)):.2f}, "
        f"y0={float(line.get('y0', 0.0)):.2f}, "
        f"x1={float(line.get('x1', 0.0)):.2f}, "
        f"y1={float(line.get('y1', 0.0)):.2f}"
    )


def append_header(output: list[str], title: str) -> None:
    output.append("")
    output.append("=" * 120)
    output.append(title)
    output.append("=" * 120)


def append_subheader(output: list[str], title: str) -> None:
    output.append("")
    output.append("-" * 120)
    output.append(title)
    output.append("-" * 120)


def dump_document_overview(output: list[str], metadata: dict[str, Any], metadata_path: Path) -> None:
    append_header(output, "DOCUMENT OVERVIEW")

    output.append(f"Debug created at: {datetime.now().isoformat(timespec='seconds')}")
    output.append(f"Metadata path: {metadata_path}")
    output.append(f"documentId: {metadata.get('documentId', '')}")
    output.append(f"filename: {metadata.get('filename', '')}")
    output.append(f"pageCount: {metadata.get('pageCount', '')}")
    output.append(f"renderZoom: {metadata.get('renderZoom', '')}")
    output.append(f"createdAt: {metadata.get('createdAt', '')}")
    output.append(f"updatedAt: {metadata.get('updatedAt', '')}")
    output.append(f"words: {len(metadata.get('words', []))}")
    output.append(f"readingBlocks: {len(metadata.get('readingBlocks', []))}")
    output.append(f"sentences/segments: {len(metadata.get('sentences', []))}")


def dump_pages(output: list[str], metadata: dict[str, Any]) -> None:
    append_header(output, "PAGES")

    pages = metadata.get("pages", [])

    for page in pages:
        output.append(
            f"Page {page.get('pageNumber')} | "
            f"{page.get('width')}x{page.get('height')}px | "
            f"{page.get('imageUrl')}"
        )


def dump_raw_words_by_page(output: list[str], words: list[dict[str, Any]]) -> None:
    append_header(output, "RAW WORDS BY PAGE")

    grouped = group_words_by_page(words)

    for page_number in sorted(grouped.keys()):
        append_subheader(output, f"PAGE {page_number} RAW WORDS")

        for index, word in enumerate(grouped[page_number], start=1):
            output.append(
                f"{index:04d} | "
                f"id={word.get('id')} | "
                f"block={word.get('blockNumber')} | "
                f"line={word.get('lineNumber')} | "
                f"word={word.get('wordNumber')} | "
                f"{format_box_from_word(word)} | "
                f"text={word.get('text')}"
            )


def dump_raw_lines_by_page(output: list[str], words: list[dict[str, Any]]) -> None:
    append_header(output, "RAW LINES BY PAGE")

    lines = group_words_to_lines(words)
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)

    for line in lines:
        grouped[int(line["pageNumber"])].append(line)

    for page_number in sorted(grouped.keys()):
        append_subheader(output, f"PAGE {page_number} RAW LINES")

        for index, line in enumerate(grouped[page_number], start=1):
            output.append(
                f"{index:04d} | "
                f"block={line.get('blockNumber')} | "
                f"line={line.get('lineNumber')} | "
                f"{format_line_box(line)} | "
                f"wordCount={len(line.get('wordIds', []))} | "
                f"text={line.get('text')}"
            )


def dump_reading_blocks(output: list[str], metadata: dict[str, Any], word_lookup: dict[str, dict[str, Any]]) -> None:
    append_header(output, "READING BLOCKS")

    reading_blocks = metadata.get("readingBlocks", [])

    for index, block in enumerate(reading_blocks, start=1):
        append_subheader(
            output,
            (
                f"BLOCK {index:04d} | "
                f"id={block.get('id', '')} | "
                f"page={block.get('pageNumber')} | "
                f"blockNumber={block.get('blockNumber')} | "
                f"type={block.get('type')} | "
                f"readMode={block.get('readMode')}"
            ),
        )

        output.append(f"text={block.get('text', '')}")
        output.append(f"wordCount={len(block.get('wordIds', []))}")
        output.append(f"lineBoxes={json.dumps(block.get('lineBoxes', []), ensure_ascii=False)}")

        output.append("")
        output.append("Words:")

        for word_position, word_id in enumerate(block.get("wordIds", []), start=1):
            word = word_lookup.get(str(word_id))

            if word is None:
                output.append(f"  {word_position:04d} | MISSING WORD | id={word_id}")
                continue

            output.append(
                f"  {word_position:04d} | "
                f"id={word.get('id')} | "
                f"page={word.get('pageNumber')} | "
                f"block={word.get('blockNumber')} | "
                f"line={word.get('lineNumber')} | "
                f"word={word.get('wordNumber')} | "
                f"text={word.get('text')}"
            )


def dump_segments(output: list[str], metadata: dict[str, Any], word_lookup: dict[str, dict[str, Any]]) -> None:
    append_header(output, "FINAL SEGMENTS / SENTENCES")

    segments = metadata.get("sentences", [])

    for index, segment in enumerate(segments, start=1):
        append_subheader(
            output,
            (
                f"SEGMENT {index:04d} | "
                f"id={segment.get('id')} | "
                f"page={segment.get('pageNumber')} | "
                f"type={segment.get('type')} | "
                f"readMode={segment.get('readMode')} | "
                f"pauseAfterMs={segment.get('pauseAfterMs')}"
            ),
        )

        output.append(f"text={segment.get('text', '')}")
        output.append(f"pageNumbers={segment.get('pageNumbers', [])}")
        output.append(f"wordCount={len(segment.get('wordIds', []))}")
        output.append(f"lineBoxes={json.dumps(segment.get('lineBoxes', []), ensure_ascii=False)}")

        output.append("")
        output.append("Words:")

        reconstructed_words: list[str] = []

        for word_position, word_id in enumerate(segment.get("wordIds", []), start=1):
            word = word_lookup.get(str(word_id))

            if word is None:
                output.append(f"  {word_position:04d} | MISSING WORD | id={word_id}")
                continue

            reconstructed_words.append(str(word.get("text", "")))

            output.append(
                f"  {word_position:04d} | "
                f"id={word.get('id')} | "
                f"page={word.get('pageNumber')} | "
                f"block={word.get('blockNumber')} | "
                f"line={word.get('lineNumber')} | "
                f"word={word.get('wordNumber')} | "
                f"{format_box_from_word(word)} | "
                f"text={word.get('text')}"
            )

        output.append("")
        output.append(f"reconstructedText={normalize_spaces(' '.join(reconstructed_words))}")


def dump_segments_compact(output: list[str], metadata: dict[str, Any]) -> None:
    append_header(output, "SEGMENTS COMPACT")

    segments = metadata.get("sentences", [])

    for index, segment in enumerate(segments, start=1):
        output.append(
            f"{index:04d} | "
            f"page={segment.get('pageNumber')} | "
            f"type={segment.get('type')} | "
            f"readMode={segment.get('readMode')} | "
            f"words={len(segment.get('wordIds', []))} | "
            f"text={segment.get('text', '')}"
        )


def dump_page_segment_mapping(output: list[str], metadata: dict[str, Any]) -> None:
    append_header(output, "PAGE → SEGMENT MAPPING")

    grouped: dict[int, list[tuple[int, dict[str, Any]]]] = defaultdict(list)

    for index, segment in enumerate(metadata.get("sentences", []), start=1):
        page_number = int(segment.get("pageNumber", 0))
        grouped[page_number].append((index, segment))

    for page_number in sorted(grouped.keys()):
        append_subheader(output, f"PAGE {page_number} SEGMENTS")

        for index, segment in grouped[page_number]:
            output.append(
                f"{index:04d} | "
                f"type={segment.get('type')} | "
                f"readMode={segment.get('readMode')} | "
                f"text={segment.get('text', '')}"
            )


def generate_debug_report(metadata_path: Path) -> Path:
    metadata = load_json(metadata_path)

    words = metadata.get("words", [])
    word_lookup = build_word_lookup(words)

    output: list[str] = []

    dump_document_overview(output, metadata, metadata_path)
    dump_pages(output, metadata)
    dump_segments_compact(output, metadata)
    dump_page_segment_mapping(output, metadata)
    dump_raw_lines_by_page(output, words)
    dump_reading_blocks(output, metadata, word_lookup)
    dump_segments(output, metadata, word_lookup)
    dump_raw_words_by_page(output, words)

    document_id = str(metadata.get("documentId", metadata_path.parent.name))
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = DEBUG_DIR / f"{document_id}_debug_{timestamp}.txt"

    write_text(output_path, "\n".join(output))
    return output_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a debug text dump for a VoiceMaster document.")
    parser.add_argument(
        "--document-id",
        type=str,
        default="",
        help="Document ID. If omitted, the latest document metadata is used.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.document_id:
        metadata_path = find_document_metadata(args.document_id)
    else:
        metadata_path = find_latest_document_metadata()

    output_path = generate_debug_report(metadata_path)

    print(f"Debug report written:")
    print(output_path)


if __name__ == "__main__":
    main()