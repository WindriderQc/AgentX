from __future__ import annotations

from pathlib import Path

import requests

from app.config import settings


MODEL_DIR = Path("cache/models")
KOKORO_MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
KOKORO_VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"


def get_kokoro_asset_paths() -> tuple[Path, Path]:
    model_path = Path(settings.kokoro_model_path) if settings.kokoro_model_path else MODEL_DIR / "kokoro-v1.0.onnx"
    voices_path = Path(settings.kokoro_voices_path) if settings.kokoro_voices_path else MODEL_DIR / "voices-v1.0.bin"
    return model_path, voices_path


def _download_file(url: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=120) as response:
        response.raise_for_status()
        with destination.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)
    return destination


def ensure_kokoro_assets() -> tuple[Path, Path]:
    model_path, voices_path = get_kokoro_asset_paths()

    if not model_path.exists():
        print(f"[assets] downloading Kokoro model to {model_path}")
        _download_file(KOKORO_MODEL_URL, model_path)

    if not voices_path.exists():
        print(f"[assets] downloading Kokoro voices to {voices_path}")
        _download_file(KOKORO_VOICES_URL, voices_path)

    return model_path, voices_path
