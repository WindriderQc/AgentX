"""Observe the local worker without publishing its session, commands or output."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import queue
import shlex
import stat
import subprocess
import tempfile
import time


REQUEST_ID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
STAGES = {"preparing", "dependencies", "model_wait", "model_generation", "tool", "test", "checkpoint", "publishing"}
PHASES = {"preparing", "running", "delivering", "finished"}
REASONS = {"hard_budget", "soft_budget_no_progress", "no_useful_progress", "model_call_limit",
           "worker_exit", "no_changes", "dependencies_failed", "dependencies_changed", "runner_error",
           "tests_failed", "generated_artifacts",
           "model_wait_inactive", "model_generation_inactive", "tool_inactive", "test_inactive"}
RESULTS = {"blocked", "review", "local_only"}
TEST_NAMES = {"pytest", "unittest", "jest", "npm_test", "node_test"}
TEST_OUTCOMES = {"passed", "failed", "unknown"}
ARTIFACT_DIRS = {".git", "node_modules", ".lab", ".npmcache", ".npm-cache", ".cache", ".dsh",
                 "coverage", "dist", "build", "test-results", "__pycache__", ".pytest_cache"}
STAGE_LIMITS = {"model_wait": 22 * 60, "model_generation": 30 * 60, "tool": 15 * 60, "test": 40 * 60}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def artifact(path: str) -> bool:
    parts = Path(path).parts
    return bool(set(parts) & ARTIFACT_DIRS or (parts and parts[-1] in {"session.jsonl", "session.jsonl.zstd"}))


def git(workspace: Path, *args: str) -> str:
    env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.run(["git", "-C", str(workspace), "-c", "core.hooksPath=/dev/null",
                           "-c", "core.fsmonitor=false", *args], env=env, capture_output=True,
                          text=True, check=True, timeout=30).stdout


def source_state(workspace: Path) -> str:
    """Hash source content, ignoring mtimes, generated caches and links outside the clone."""
    paths = git(workspace, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0")
    digest = hashlib.sha256()
    for name in sorted(set(paths)):
        if not name or artifact(name):
            continue
        path = workspace / name
        try:
            info = path.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_size <= 32 * 1024 * 1024:
                content = hashlib.sha256(path.read_bytes()).digest()
            elif stat.S_ISLNK(info.st_mode):
                content = os.readlink(path).encode()
            else:
                continue
        except FileNotFoundError:
            content = b"deleted"
        digest.update(name.encode() + b"\0" + content)
    return digest.hexdigest()


def test_kind(command: str) -> str | None:
    try:
        shlex.split(command)
    except ValueError:
        return None
    # A mention in an echo, comment or model answer is not a test command.
    segments = re.split(r"\s*(?:&&|;|\|\|)\s*", command)
    for segment in segments:
        try:
            tokens = shlex.split(segment)
        except ValueError:
            continue
        while tokens and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[0]):
            tokens.pop(0)
        if not tokens:
            continue
        exe = Path(tokens[0]).name
        if exe in {"pytest", "pytest-3"}:
            return "pytest"
        if exe in {"python", "python3"} and tokens[1:3] in [["-m", "pytest"], ["-m", "unittest"]]:
            return tokens[2]
        if exe in {"jest", "npx"} and (exe == "jest" or tokens[1:2] == ["jest"]):
            return "jest"
        if exe in {"npm", "pnpm", "yarn"} and any(re.fullmatch(r"test(?::[\w-]+)?", t) for t in tokens[1:3]):
            return "npm_test"
        if exe == "node" and any(t.endswith("run-jest.js") for t in tokens[1:2]):
            return "jest"
        if exe == "node" and "--test" in tokens:
            return "node_test"
    return None


def message_text(message: dict) -> str:
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(message_text(item) if item.get("type") == "tool-result" else item.get("text", "")
                         for item in content if isinstance(item, dict))
    return ""


def safe_progress(value: object, request_id: str, task_id: str) -> dict | None:
    """Whitelist the receipt at the read boundary, including all nested fields."""
    if not isinstance(value, dict) or value.get("requestId") != request_id or value.get("pipelineId") != task_id:
        return None
    def allowed(item, choices):
        return item if isinstance(item, str) and item in choices else None

    if not allowed(value.get("phase"), PHASES) or not allowed(value.get("stage"), STAGES):
        return None
    result = {"requestId": request_id, "pipelineId": task_id, "phase": value["phase"], "stage": value["stage"]}
    for field in ["heartbeatAt", "progressAt", "activityAt", "startedAt"]:
        item = value.get(field)
        try:
            parsed = datetime.fromisoformat(item.replace("Z", "+00:00")) if isinstance(item, str) else None
            result[field] = parsed.astimezone(timezone.utc).isoformat() if parsed and parsed.tzinfo else None
        except (ValueError, OverflowError):
            result[field] = None
    for field in ["softRemainingSeconds", "hardRemainingSeconds", "modelCalls", "extensions"]:
        item = value.get(field)
        result[field] = item if type(item) is int and 0 <= item <= 86400 else None
    result["stopReason"] = allowed(value.get("stopReason"), REASONS)
    result["result"] = allowed(value.get("result"), RESULTS)
    result["currentTest"] = allowed(value.get("currentTest"), TEST_NAMES)
    last = value.get("lastTest")
    result["lastTest"] = ({"name": last["name"], "outcome": last["outcome"]}
                          if isinstance(last, dict) and allowed(last.get("name"), TEST_NAMES) and allowed(last.get("outcome"), TEST_OUTCOMES) else None)
    checkpoint = value.get("checkpoint")
    result["checkpoint"] = checkpoint if isinstance(checkpoint, str) and re.fullmatch(r"[a-f0-9]{40}", checkpoint) else None
    return result


class Progress:
    def __init__(self, task_id: str, request_id: str = "", soft_seconds: int = 7200,
                 *, receipts: Path | None = None, heartbeat=None, now=time.monotonic):
        self.task_id, self.request_id, self.now, self.heartbeat = task_id, request_id, now, heartbeat
        self.path = receipts / f"{request_id}.progress.json" if receipts and request_id else None
        self.started = self.stage_since = self.last_activity = self.last_useful = self.now()
        self.soft_deadline = self.started + soft_seconds
        self.hard_deadline = self.started + 2 * soft_seconds
        self.extension_seconds = min(1800, soft_seconds)
        self.last_extension = self.started
        self.started_at = utc_now()
        self.heartbeat_at = self.progress_at = self.activity_at = None
        self.last_heartbeat = None
        self.stage, self.phase = "preparing", "preparing"
        self.stop_reason = self.result = self.checkpoint = self.current_test = self.last_test = None
        self.model_calls = self.extensions = 0
        self.offsets, self.pending_tests = {}, {}
        self.model_events = queue.SimpleQueue()
        self.seen_states, self.seen_tests = set(), set()
        self.source_signature = None
        self.write()

    def write(self):
        if not self.path:
            return
        current = self.now()
        value = {"requestId": self.request_id, "pipelineId": self.task_id, "phase": self.phase,
                 "stage": self.stage, "startedAt": self.started_at, "heartbeatAt": self.heartbeat_at,
                 "activityAt": self.activity_at, "progressAt": self.progress_at, "modelCalls": self.model_calls,
                 "extensions": self.extensions, "currentTest": self.current_test, "lastTest": self.last_test,
                 "stopReason": self.stop_reason, "checkpoint": self.checkpoint, "result": self.result,
                 "softRemainingSeconds": max(0, int(self.soft_deadline - current)),
                 "hardRemainingSeconds": max(0, int(self.hard_deadline - current))}
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=self.path.parent, prefix=".progress-", delete=False) as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
            temporary = output.name
        os.replace(temporary, self.path)

    def set_stage(self, stage: str):
        if self.stage != stage:
            self.stage, self.stage_since = stage, self.now()
        self.last_activity, self.activity_at = self.now(), utc_now()

    def useful(self):
        self.last_useful, self.progress_at = self.now(), utc_now()

    def event(self, entry: object, session: str = ""):
        if not isinstance(entry, dict) or not isinstance(entry.get("data"), dict):
            return
        kind, data = entry.get("type"), entry["data"]
        if kind in {"step/start", "request/header"}:
            self.set_stage("model_wait")
        elif kind == "assistant/chunk":
            self.set_stage("model_generation")
        elif kind == "tool/call":
            args = data.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            name = test_kind(str(args.get("command", ""))) if isinstance(args, dict) and data.get("name") == "bash" else None
            call_id = data.get("callId")
            if isinstance(call_id, str) and name:
                self.pending_tests[(session, call_id)] = (name, hashlib.sha256(str(args.get("command", "")).encode()).hexdigest())
            self.current_test = next(iter(self.pending_tests.values()))[0] if self.pending_tests else None
            self.set_stage("test" if self.current_test else "tool")
        elif kind == "tool/result":
            message = data.get("message") or {}
            if not isinstance(message, dict):
                return
            source = message.get("source") or {}
            call_id = source.get("callId") if isinstance(source, dict) else None
            pending = self.pending_tests.pop((session, call_id), None)
            if pending:
                content = message_text(message)
                blocks = message.get("content", [])
                errored = message.get("isError") or (isinstance(blocks, list) and any(
                    isinstance(block, dict) and block.get("isError") for block in blocks))
                outcome = ("unknown" if re.search(r"\[(?:timed out|killed by signal)", content)
                           else "failed" if errored or re.search(r"\[exit code: [1-9]\d*\]", content)
                           else "passed")
                signature = (pending[1], outcome, self.source_signature)
                if outcome != "unknown" and signature not in self.seen_tests:
                    self.seen_tests.add(signature)
                    self.useful()
                self.last_test = {"name": pending[0], "outcome": outcome}
            self.current_test = next(iter(self.pending_tests.values()))[0] if self.pending_tests else None
            self.set_stage("test" if self.current_test else "model_wait")

    def baseline(self, home: Path, workspace: Path):
        for path in (home / ".dsh/progress-sessions").glob("**/session.jsonl"):
            if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(home.resolve()):
                self.offsets[path] = path.stat().st_size
        self.source_signature = source_state(workspace)
        self.seen_states.add(self.source_signature)

    def scan(self, home: Path, workspace: Path):
        self.source_signature = source_state(workspace)
        if self.source_signature not in self.seen_states:
            self.seen_states.add(self.source_signature)
            self.useful()
        for path in (home / ".dsh/progress-sessions").glob("**/session.jsonl"):
            if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(home.resolve()):
                continue
            offset = self.offsets.get(path, 0)
            with path.open("rb") as stream:
                stream.seek(offset)
                for _ in range(10000):
                    line = stream.readline(4 * 1024 * 1024)
                    if not line:
                        break
                    if not line.endswith(b"\n"):
                        if len(line) < 4 * 1024 * 1024:
                            break  # A torn last record is retried from its original offset.
                        while line and not line.endswith(b"\n"):
                            line = stream.readline(4 * 1024 * 1024)
                        offset = stream.tell()
                        continue
                    offset = stream.tell()
                    try:
                        self.event(json.loads(line), str(path))
                    except (ValueError, UnicodeDecodeError):
                        continue
            self.offsets[path] = offset

    def observe(self, home: Path | None = None, workspace: Path | None = None):
        while not self.model_events.empty():
            if self.model_events.get() == "model_request":
                self.model_calls += 1
                self.set_stage("model_wait")
        if home and workspace:
            self.scan(home, workspace)

    def tick(self, home: Path | None = None, workspace: Path | None = None):
        self.observe(home, workspace)
        current = self.now()
        if self.last_heartbeat is None or current - self.last_heartbeat >= 20:
            if self.heartbeat:
                try:
                    self.heartbeat()
                except (OSError, RuntimeError):
                    pass
            self.last_heartbeat, self.heartbeat_at = current, utc_now()
        if self.phase == "running":
            if current >= self.soft_deadline and current < self.hard_deadline:
                if self.last_useful > self.last_extension and current - self.last_useful < min(1800, self.extension_seconds):
                    self.soft_deadline = min(self.hard_deadline, current + self.extension_seconds)
                    self.last_extension = current
                    self.extensions += 1
            if current >= self.hard_deadline:
                self.stop_reason = "hard_budget"
            elif current >= self.soft_deadline:
                self.stop_reason = "soft_budget_no_progress"
            elif self.model_calls >= 128:
                self.stop_reason = "model_call_limit"
            elif self.stage in STAGE_LIMITS and current - self.stage_since >= STAGE_LIMITS[self.stage]:
                self.stop_reason = f"{self.stage}_inactive"
            elif self.stage not in {"model_wait", "test"} and current - self.last_useful >= 45 * 60:
                self.stop_reason = "no_useful_progress"
        self.write()
        return self.stop_reason

    def finish(self, result: str, reason: str | None = None, checkpoint: str | None = None):
        self.phase, self.result = "finished", result
        self.stop_reason = reason or self.stop_reason
        self.checkpoint = checkpoint
        self.write()
