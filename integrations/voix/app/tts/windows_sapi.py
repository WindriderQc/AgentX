"""Windows SAPI TTS provider.

This provider uses the built-in System.Speech synthesizer through Windows
PowerShell and returns in-memory float32 samples like the Kokoro provider.
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from functools import lru_cache

import numpy as np

from app.config import settings


def preload() -> None:
    _powershell()


def synthesize(text: str, *, voice=None, language=None) -> tuple[np.ndarray, int, float]:
    started = time.perf_counter()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = tmp.name
    try:
        _run_sapi(text, out_path, resolve_voice(voice, language))
        import soundfile as sf

        samples, sample_rate = sf.read(out_path, dtype="float32")
        samples = np.asarray(samples, dtype=np.float32)
        if samples.ndim > 1:
            samples = samples[:, 0]
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        return samples.reshape(-1), int(sample_rate), elapsed_ms
    finally:
        try:
            Path(out_path).unlink()
        except OSError:
            pass


def _powershell() -> str:
    # System.Speech on the installed .NET runtime also exposes OneCore voices.
    # Windows PowerShell's older .NET Framework sees only Desktop voices here.
    # Discovery and synthesis must use the exact same host.
    exe = shutil.which("pwsh.exe") or shutil.which("pwsh") or shutil.which("powershell.exe") or shutil.which("powershell")
    if not exe:
        raise RuntimeError("TTS_PROVIDER=windows_sapi requires Windows PowerShell.")
    return exe


def _b64(value: str) -> str:
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


@lru_cache(maxsize=1)
def installed_voices() -> list[dict]:
    if os.name != "nt":
        return []
    script = """
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  @($synth.GetInstalledVoices() | Where-Object Enabled | ForEach-Object {
    @{name=$_.VoiceInfo.Name; locale=$_.VoiceInfo.Culture.Name; gender=$_.VoiceInfo.Gender.ToString().ToLowerInvariant()}
  }) | ConvertTo-Json -Compress
} finally { $synth.Dispose() }
"""
    data = json.loads(_execute(script).stdout or "[]")
    return data if isinstance(data, list) else [data]


def resolve_voice(voice=None, language=None) -> str:
    requested = str(voice or "").strip()
    locale = str(language or "").lower()
    voices = installed_voices()
    if requested:
        match = next((v for v in voices if v["name"].lower() == requested.lower()), None)
        if match is None:
            raise ValueError("The selected Windows voice is not installed")
        return match["name"]
    configured = next((v for v in voices if v["name"] == settings.windows_sapi_voice), None)
    if configured and (not locale or configured["locale"][:2].lower() == locale[:2]):
        return configured["name"]
    matching = [v for v in voices if not locale or v["locale"][:2].lower() == locale[:2]]
    matching.sort(key=lambda v: (not v["locale"].lower().endswith("-ca"), v["name"]))
    if not matching:
        raise ValueError("No installed Windows voice supports this language")
    return matching[0]["name"]


def _run_sapi(text: str, out_path: str, voice: str) -> None:
    rate = max(-10, min(10, settings.windows_sapi_rate))
    sample_rate = max(8000, settings.tts_output_rate)
    script = f"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{_b64(text)}'))
$outPath = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{_b64(out_path)}'))
$voice = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{_b64(voice)}'))
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {{
  if ($voice.Trim().Length -gt 0) {{ $synth.SelectVoice($voice) }}
  $synth.Rate = {rate}
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo({sample_rate}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($outPath, $format)
  [void]$synth.Speak($text)
}} finally {{
  $synth.Dispose()
}}
"""
    _execute(script)


def _execute(script: str):
    script = "$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()\n" + script
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    return subprocess.run(
        [
            _powershell(),
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
        ],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )
