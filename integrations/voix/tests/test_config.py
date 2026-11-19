"""Production dotenv loading and the opt-in test override in fresh processes."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from app import config


@pytest.mark.parametrize("skip,shell_language,expected", [
    (False, None, {"language": "en", "provider": "windows_sapi", "device": "cpu"}),
    (True, None, {"language": "fr", "provider": "kokoro", "device": "cpu"}),
    (False, "fr", {"language": "fr", "provider": "windows_sapi", "device": "cpu"}),
])
def test_dotenv_is_optional_and_shell_settings_keep_precedence(
    tmp_path, skip, shell_language, expected,
):
    package = tmp_path / "app"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "config.py").write_text(Path(config.__file__).read_text())
    (tmp_path / ".env").write_text("VOIX_LANGUAGE=en\nTTS_PROVIDER=windows_sapi\n")
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("VOIX_", "WHISPER_", "KOKORO_", "TTS_",
                                  "VOXCPM_", "WINDOWS_SAPI_")) and key != "ONNX_PROVIDER"}
    env.update(PYTHONPATH=str(tmp_path), WHISPER_DEVICE="cpu")
    if skip:
        env["VOIX_SKIP_DOTENV"] = "1"
    if shell_language:
        env["VOIX_LANGUAGE"] = shell_language
    result = subprocess.run([
        sys.executable, "-c",
        "import json; from app.config import settings; "
        "print(json.dumps(dict(language=settings.voix_language, "
        "provider=settings.tts_provider, device=settings.whisper_device)))",
    ], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == expected


@pytest.mark.parametrize("value", ["0", "4"])
def test_cpu_thread_budget_accepts_zero_and_explicit_limits(monkeypatch, value):
    monkeypatch.setenv("WHISPER_CPU_THREADS", value)
    assert config.load_settings().whisper_cpu_threads == int(value)


def test_negative_cpu_thread_budget_is_rejected(monkeypatch):
    monkeypatch.setenv("WHISPER_CPU_THREADS", "-1")
    with pytest.raises(ValueError, match="WHISPER_CPU_THREADS"):
        config.load_settings()
