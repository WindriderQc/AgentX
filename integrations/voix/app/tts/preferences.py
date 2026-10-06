"""Persist only the speech choices (engine and voices), never secrets."""
import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile

FIELDS = ("tts_provider", "tts_voice_en", "tts_voice_fr")


def path() -> Path:
    default = Path(os.getenv("LOCALAPPDATA", str(Path.home() / ".local/share"))) / "VoiX/voice-preferences.json"
    return Path(os.getenv("VOIX_PREFERENCES_PATH", str(default)))


def load(config) -> str:
    try:
        data = json.loads(path().read_text(encoding="utf-8"))
        config.update({key: data[key] for key in FIELDS if key in data})
        return ""
    except FileNotFoundError:
        return ""
    except (OSError, ValueError, TypeError):
        return "Saved speech preferences could not be loaded; startup defaults are active"


def save(config) -> None:
    target = path()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as file:
            temporary = Path(file.name)
            json.dump({key: getattr(config, key) for key in FIELDS}, file, indent=2)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
