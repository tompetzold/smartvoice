from __future__ import annotations

import re
import unicodedata
from datetime import datetime


GERMAN_MONTHS = {
    1: "Januar",
    2: "Februar",
    3: "März",
    4: "April",
    5: "Mai",
    6: "Juni",
    7: "Juli",
    8: "August",
    9: "September",
    10: "Oktober",
    11: "November",
    12: "Dezember",
}

ABBREVIATION_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\bz\s*\.\s*B\s*\.", "zum Beispiel"),
    (r"\bd\s*\.\s*h\s*\.", "das heißt"),
    (r"\bu\s*\.\s*a\s*\.", "unter anderem"),
    (r"\bu\s*\.\s*Ä\s*\.", "und Ähnliche"),
    (r"\bbzw\s*\.", "beziehungsweise"),
    (r"\bca\s*\.", "circa"),
    (r"\bggf\s*\.", "gegebenenfalls"),
    (r"\binsb\s*\.", "insbesondere"),
    (r"\bvgl\s*\.", "vergleiche"),
    (r"\bAbb\s*\.", "Abbildung"),
    (r"\bTab\s*\.", "Tabelle"),
    (r"\bKap\s*\.", "Kapitel"),
    (r"\bAbs\s*\.", "Absatz"),
    (r"\bNr\s*\.", "Nummer"),
    (r"\bAufl\s*\.", "Auflage"),
    (r"\bHrsg\s*\.", "Herausgeber"),
    (r"\bProf\s*\.", "Professor"),
    (r"\bDr\s*\.", "Doktor"),
)

ACRONYM_REPLACEMENTS: tuple[tuple[str, str], ...] = (
    ("KI", "K I"),
    ("AI", "A I"),
    ("ML", "M L"),
    ("LLM", "L L M"),
    ("PDF", "P D F"),
    ("OCR", "O C R"),
    ("TTS", "T T S"),
    ("API", "A P I"),
    ("EU", "E U"),
    ("DSGVO", "D S G V O"),
)


def normalize_spaces(text: str) -> str:
    return re.sub(r"[ \t\f\v]+", " ", text).strip()


def _normalize_paragraphs(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)

    paragraphs = []
    for paragraph in text.split("\n\n"):
        compact = re.sub(r"\s*\n\s*", " ", paragraph)
        compact = normalize_spaces(compact)
        if compact:
            paragraphs.append(compact)

    return "\n\n".join(paragraphs)


def _normalize_date_match(match: re.Match[str]) -> str:
    day = int(match.group("day"))
    month = int(match.group("month"))
    year = match.group("year")

    if month not in GERMAN_MONTHS or day < 1 or day > 31:
        return match.group(0)

    if len(year) == 2:
        numeric_year = int(year)
        year = str(2000 + numeric_year if numeric_year <= 69 else 1900 + numeric_year)

    try:
        datetime(int(year), month, min(day, 28))
    except ValueError:
        return match.group(0)

    return f"{day}. {GERMAN_MONTHS[month]} {year}"


def normalize_german_tts_text(text: str) -> str:
    if not text:
        return ""

    normalized = unicodedata.normalize("NFKC", str(text))
    normalized = normalized.replace("\u00ad", "")
    normalized = normalized.replace("\u200b", "")

    normalized = re.sub(
        r"(?<=[A-Za-zÄÖÜäöüß])-\s+(?=[a-zäöüß]{2,}\b)",
        "",
        normalized,
    )

    normalized = _normalize_paragraphs(normalized)

    normalized = re.sub(
        r"\b(?P<day>0?[1-9]|[12]\d|3[01])\.(?P<month>0?[1-9]|1[0-2])\.(?P<year>\d{2}|\d{4})\b",
        _normalize_date_match,
        normalized,
    )

    normalized = re.sub(r"(?<!\w)(\d+(?:[.,]\d+)?)\s*%", r"\1 Prozent", normalized)
    normalized = re.sub(r"(?<!\w)(\d+(?:[.,]\d+)?)\s*€", r"\1 Euro", normalized)
    normalized = re.sub(r"(?<!\w)(\d+(?:[.,]\d+)?)\s*EUR\b", r"\1 Euro", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"(?<!\w)(\d+(?:[.,]\d+)?)\s*°\s*C\b", r"\1 Grad Celsius", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"§\s*(\d+[a-zA-Z]?)", r"Paragraph \1", normalized)

    normalized = re.sub(r"\bS\s*\.\s*(?=\d)", "Seite ", normalized)

    for pattern, replacement in ABBREVIATION_PATTERNS:
        normalized = re.sub(pattern, replacement, normalized, flags=re.IGNORECASE)

    for acronym, spoken in ACRONYM_REPLACEMENTS:
        normalized = re.sub(rf"\b{re.escape(acronym)}\b", spoken, normalized)

    normalized = re.sub(r"\s+([,;:.!?])", r"\1", normalized)
    normalized = re.sub(r",(?=[A-Za-zÄÖÜäöüß])", ", ", normalized)
    normalized = re.sub(r"([;:!?])(?=\S)", r"\1 ", normalized)
    normalized = re.sub(r"\.\.\.+", "…", normalized)
    normalized = re.sub(r"\s*\n\n\s*", "\n\n", normalized)

    return _normalize_paragraphs(normalized)
