"""Turn model output into text that is safe to say aloud."""
from __future__ import annotations

import re
import unicodedata


_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_LINE_PREFIX = re.compile(r"(?m)^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)")
_WHITESPACE = re.compile(r"\s+")
_WORD = re.compile(r"[a-z]+(?:'[a-z]+)?")

_ENGLISH_MARKERS = frozenset({
    "a", "about", "all", "am", "an", "and", "are", "as", "be", "but",
    "can", "could", "do", "does", "english", "enough", "fair", "for",
    "from", "have", "hello", "help", "how", "i", "in", "is", "it", "keep",
    "me", "my", "of", "on", "please", "should", "so", "sound", "sure",
    "switch", "tell", "that", "the", "thing", "this", "to", "voice", "we",
    "weird", "what", "when", "with", "would", "yes", "you", "your",
})
_FRENCH_MARKERS = frozenset({
    "a", "ai", "au", "aux", "avec", "bien", "bonjour", "ca", "ce", "ces",
    "comment", "dans", "de", "des", "du", "elle", "en", "est", "et", "faire",
    "francais", "il", "je", "la", "le", "les", "mais", "me", "mon", "ne",
    "nous", "on", "ou", "pas", "peux", "plus", "pour", "pourquoi", "que",
    "qui", "quoi", "reponse", "sais", "sont", "sur", "te", "toi", "ton",
    "tout", "tu", "une", "vous", "oui",
})


def _base_language(language: str | None) -> str:
    value = str(language or "fr").strip().lower().replace("_", "-")
    return "en" if value.startswith("en") else "fr"


def detect_language(text: str, *, default: str = "fr") -> str:
    """Detect conversational French/English while keeping short turns sticky.

    VoiX intentionally supports only the two released speech profiles. Ambiguous
    names and one-word replies inherit the current conversation language.
    """
    raw = str(text or "").strip()
    if not raw:
        return _base_language(default)
    ascii_text = unicodedata.normalize("NFKD", raw.casefold())
    ascii_text = "".join(char for char in ascii_text if not unicodedata.combining(char))
    words = _WORD.findall(ascii_text)
    english = sum(word in _ENGLISH_MARKERS for word in words)
    french = sum(word in _FRENCH_MARKERS for word in words)
    if re.search(r"\b(?:j|l|d|qu|c|n|m|t|s)'", ascii_text):
        french += 2
    if re.search(r"[àâçéèêëîïôùûüÿœ]", raw.casefold()):
        french += 2
    if english and not french and (english >= 2 or len(words) <= 2):
        return "en"
    if french and not english and (french >= 2 or len(words) <= 2):
        return "fr"
    if english >= french + 2:
        return "en"
    if french >= english + 2:
        return "fr"
    return _base_language(default)


def sanitize_for_speech(text: str) -> str:
    """Remove visual Markdown tokens that speech engines pronounce literally.

    The displayed reply remains untouched; this function is only for the audio
    projection of a clause. The provider facade applies this to every engine
    and caller.
    """
    value = str(text or "")
    value = re.sub(r"\\([*_`])", r"\1", value)
    value = _IMAGE.sub(r"\1", value)
    value = _LINK.sub(r"\1", value)
    value = _LINE_PREFIX.sub("", value)
    value = value.replace("`", "")
    value = value.replace("*", "")
    value = value.replace("_", " ")
    value = _WHITESPACE.sub(" ", value)
    return value.strip()
