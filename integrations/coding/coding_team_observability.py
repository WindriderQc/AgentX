#!/usr/bin/env python3
"""Privacy-safe energy evidence and event-only coding-team notifications."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import statistics
import subprocess
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Iterable
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ENERGY_SCOPE = "gpu-incremental-lower-bound"
ENERGY_SOURCE = "nvidia-smi-baseline-integral/v1"
TARIFF_SOURCE = "operator-configured-electricity-tariff/v1"
TELEGRAM_EVENTS = {
    "claimed",
    "blocked",
    "review-ready",
    "lease-stale",
    "pr-ready",
    "deployed",
}
PIPELINE_ID = re.compile(r"^\d{3,4}$")
SSH_OPTIONS = (
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=10",
    "-o", "ServerAliveCountMax=3",
)


class ObservabilityError(RuntimeError):
    """Raised when evidence cannot be produced without guessing."""


def _fingerprint(value: dict[str, Any]) -> str:
    payload = json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def parse_nvidia_smi_power(text: str, gpu_indices: Iterable[int]) -> int:
    expected = set(gpu_indices)
    observed: dict[int, int] = {}
    for line in str(text or "").splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 2:
            continue
        try:
            index = int(parts[0])
            milliwatts = round(float(parts[1]) * 1000)
        except ValueError:
            continue
        if index in expected and milliwatts >= 0:
            observed[index] = milliwatts
    if set(observed) != expected:
        raise ObservabilityError("energy_meter_incomplete_gpu_sample")
    return sum(observed.values())


def ssh_power_reader(
    host: str,
    gpu_indices: tuple[int, ...],
    *,
    timeout: int = 15,
) -> int:
    completed = subprocess.run(
        [
            "ssh", *SSH_OPTIONS, host,
            "nvidia-smi --query-gpu=index,power.draw --format=csv,noheader,nounits",
        ],
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    if completed.returncode != 0:
        raise ObservabilityError("energy_meter_command_failed")
    return parse_nvidia_smi_power(completed.stdout, gpu_indices)


def integrate_incremental_energy_mj(
    samples: list[tuple[float, int]],
    baseline_milliwatts: int,
) -> tuple[int, int]:
    if len(samples) < 2:
        raise ObservabilityError("energy_meter_insufficient_run_samples")
    ordered = sorted(samples)
    energy_millijoules = 0.0
    for (left_at, left_power), (right_at, right_power) in zip(ordered, ordered[1:]):
        duration = right_at - left_at
        if duration <= 0:
            continue
        left_increment = max(0, left_power - baseline_milliwatts)
        right_increment = max(0, right_power - baseline_milliwatts)
        energy_millijoules += ((left_increment + right_increment) / 2) * duration
    duration_ms = round((ordered[-1][0] - ordered[0][0]) * 1000)
    if duration_ms < 1:
        raise ObservabilityError("energy_meter_invalid_run_window")
    return max(0, round(energy_millijoules)), duration_ms


class NvidiaSmiEnergySampler:
    """Samples a dedicated GPU host and integrates baseline-subtracted power."""

    def __init__(
        self,
        host: str,
        gpu_indices: Iterable[int],
        *,
        baseline_seconds: float = 10.0,
        interval_seconds: float = 1.0,
        reader: Callable[[], int] | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        indices = tuple(sorted(set(int(index) for index in gpu_indices)))
        if not host or not indices:
            raise ObservabilityError("energy_meter_configuration_incomplete")
        if not (2 <= baseline_seconds <= 120) or not (0.25 <= interval_seconds <= 10):
            raise ObservabilityError("energy_meter_sampling_bounds_invalid")
        self.host = host
        self.gpu_indices = indices
        self.baseline_seconds = float(baseline_seconds)
        self.interval_seconds = float(interval_seconds)
        self.reader = reader or (lambda: ssh_power_reader(self.host, self.gpu_indices))
        self.clock = clock
        self.sleeper = sleeper
        self.baseline_milliwatts: int | None = None
        self.samples: list[tuple[float, int]] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._error: Exception | None = None

    def collect_baseline(self) -> int:
        count = max(3, round(self.baseline_seconds / self.interval_seconds))
        readings: list[int] = []
        for index in range(count):
            readings.append(self.reader())
            if index + 1 < count:
                self.sleeper(self.interval_seconds)
        self.baseline_milliwatts = round(statistics.median(readings))
        return self.baseline_milliwatts

    def _sample(self) -> None:
        try:
            self.samples.append((self.clock(), self.reader()))
        except Exception as exc:  # surfaced by stop(), never converted to zero
            self._error = exc
            self._stop.set()

    def _run(self) -> None:
        self._sample()
        while not self._stop.wait(self.interval_seconds):
            self._sample()

    def start(self) -> None:
        if self.baseline_milliwatts is None:
            raise ObservabilityError("energy_meter_baseline_missing")
        self._thread = threading.Thread(target=self._run, name="coding-team-energy", daemon=True)
        self._thread.start()

    def stop(self) -> dict[str, Any]:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=max(5.0, self.interval_seconds * 3))
        self._sample()
        if self._error is not None:
            raise ObservabilityError("energy_meter_run_sample_failed") from self._error
        if self.baseline_milliwatts is None:
            raise ObservabilityError("energy_meter_baseline_missing")
        energy_mj, duration_ms = integrate_incremental_energy_mj(
            self.samples,
            self.baseline_milliwatts,
        )
        evidence = {
            "measurementScope": ENERGY_SCOPE,
            "energyMillijoules": energy_mj,
            "measurementDurationMs": duration_ms,
            "sampleCount": len(self.samples),
            "baselineMilliwatts": self.baseline_milliwatts,
            "source": ENERGY_SOURCE,
        }
        return {**evidence, "evidenceFingerprint": _fingerprint(evidence)}


def attach_tariff(
    energy_evidence: dict[str, Any],
    *,
    currency: str | None,
    rate_nano_currency_units_per_kwh: int | None,
) -> dict[str, Any]:
    evidence = dict(energy_evidence)
    if currency in (None, "") and rate_nano_currency_units_per_kwh is None:
        return evidence
    normalized_currency = str(currency or "").strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", normalized_currency):
        raise ObservabilityError("electricity_tariff_currency_invalid")
    rate = -1 if rate_nano_currency_units_per_kwh is None else int(rate_nano_currency_units_per_kwh)
    if rate < 0:
        raise ObservabilityError("electricity_tariff_rate_invalid")
    energy_mj = int(evidence["energyMillijoules"])
    estimated = (energy_mj * rate + 1_800_000_000) // 3_600_000_000
    tariff = {
        "currency": normalized_currency,
        "rateNanoCurrencyUnitsPerKwh": rate,
        "estimatedCostNanoCurrencyUnits": estimated,
        "source": TARIFF_SOURCE,
    }
    evidence["tariff"] = {**tariff, "evidenceFingerprint": _fingerprint(tariff)}
    return evidence


def coding_team_message(
    event: str,
    pipeline_id: str,
    *,
    attempt: int,
    observed_at: str,
    ui_base: str,
) -> str:
    if event not in TELEGRAM_EVENTS:
        raise ObservabilityError("coding_team_notification_event_invalid")
    if not PIPELINE_ID.fullmatch(str(pipeline_id or "")):
        raise ObservabilityError("coding_team_notification_pipeline_id_invalid")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or not (1 <= attempt <= 10):
        raise ObservabilityError("coding_team_notification_attempt_invalid")
    timestamp = datetime.fromisoformat(str(observed_at).replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        raise ObservabilityError("coding_team_notification_timestamp_invalid")
    link = str(ui_base or "").rstrip("/")
    if not re.fullmatch(r"https?://[^\s?#]+(?:/[^\s?#]*)?", link):
        raise ObservabilityError("coding_team_notification_ui_base_invalid")
    return "\n".join((
        "AgentX Coding Team",
        f"Task {pipeline_id} · attempt {attempt} · {event}",
        f"Observed {timestamp.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')}",
        f"Open {link}?task={pipeline_id}",
    ))


def send_coding_team_telegram(
    event: str,
    pipeline_id: str,
    *,
    attempt: int,
    ui_base: str,
    enabled: bool,
    env: dict[str, str] | None = None,
    opener: Callable[..., Any] = urlopen,
) -> bool:
    if not enabled:
        return False
    values = os.environ if env is None else env
    token = str(values.get("CODING_TEAM_TELEGRAM_BOT_TOKEN") or "").strip()
    chat_id = str(values.get("CODING_TEAM_TELEGRAM_CHAT_ID") or "").strip()
    topic_id = str(values.get("CODING_TEAM_TELEGRAM_TOPIC_ID") or "").strip()
    if len(token) < 20 or not re.fullmatch(r"-?\d+", chat_id):
        raise ObservabilityError("coding_team_telegram_configuration_incomplete")
    if topic_id and not re.fullmatch(r"\d+", topic_id):
        raise ObservabilityError("coding_team_telegram_topic_invalid")
    message = coding_team_message(
        event,
        pipeline_id,
        attempt=attempt,
        observed_at=datetime.now(timezone.utc).isoformat(),
        ui_base=ui_base,
    )
    body = {
        "chat_id": chat_id,
        "text": message,
        "disable_web_page_preview": "true",
    }
    if topic_id:
        body["message_thread_id"] = topic_id
    request = Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=urlencode(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with opener(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise ObservabilityError("coding_team_telegram_delivery_failed") from exc
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise ObservabilityError("coding_team_telegram_rejected")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Emit one fixed-field Coding Team event.")
    parser.add_argument("--event", required=True, choices=sorted(TELEGRAM_EVENTS))
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--attempt", required=True, type=int)
    parser.add_argument("--ui-base", default="http://127.0.0.1:3180/pipeline")
    parser.add_argument(
        "--send",
        action="store_true",
        help="Use private Telegram environment credentials; omission is a network-free preview",
    )
    args = parser.parse_args()
    try:
        if args.send:
            send_coding_team_telegram(
                args.event,
                args.task_id,
                attempt=args.attempt,
                ui_base=args.ui_base,
                enabled=True,
            )
            result = "sent"
        else:
            coding_team_message(
                args.event,
                args.task_id,
                attempt=args.attempt,
                observed_at=datetime.now(timezone.utc).isoformat(),
                ui_base=args.ui_base,
            )
            result = "preview-valid"
        print(json.dumps({"ok": True, "event": args.event, "result": result}, sort_keys=True))
        return 0
    except ObservabilityError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
