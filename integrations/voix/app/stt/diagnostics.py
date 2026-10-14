"""Numerical recognition evidence, never audio, raw words or a confidence claim."""
from __future__ import annotations

import math


def finite(value, low=0, high=float("inf")):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and low <= value <= high


def recognition_evidence(info, segments, requested, *, constrained=False, changed=False):
    result = {
        "schema": 1,
        "requestedLanguage": requested,
        "languageSource": "constrained" if constrained else "detected" if requested in {"auto", "fr-en"} else "requested",
        "segments": len(segments),
        "normalizationChanged": changed,
    }
    for source, target in [("duration", "audioSeconds"), ("duration_after_vad", "speechSeconds")]:
        value = getattr(info, source, None)
        if finite(value):
            result[target] = round(value, 4)
    language = getattr(info, "language", None)
    if segments and isinstance(language, str) and 0 < len(language) <= 16:
        result["decodedLanguage"] = language
    # These are decoder diagnostics, not calibrated probabilities that the
    # person's words are right. Never reject/replace a short answer using them.
    for source, target, low, high in [
        ("avg_logprob", "avgLogProbability", -100, 0),
        ("no_speech_prob", "maxNoSpeechProbability", 0, 1),
        ("compression_ratio", "maxCompressionRatio", 0, 100),
    ]:
        values = [getattr(segment, source, None) for segment in segments]
        if values and all(finite(value, low, high) for value in values):
            result[target] = round(sum(values) / len(values) if source == "avg_logprob" else max(values), 4)
    return result
