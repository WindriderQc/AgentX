"""Observe the local worker without publishing its session, commands or output."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib, importlib.util, json, os, queue, re
from pathlib import Path
import shlex, signal, stat, subprocess, tempfile, time

_code_steps_spec = importlib.util.spec_from_file_location("coding_step_progress", Path(__file__).with_name("coding_step_progress.py"))
coding_step_progress = importlib.util.module_from_spec(_code_steps_spec)
_code_steps_spec.loader.exec_module(coding_step_progress)


REQUEST_ID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
MANUAL_MODEL_CALL_LIMIT = 128
REPORT_MODEL_CALL_LIMIT_MAX = 256


def report_call_limit(value=None):
    value = MANUAL_MODEL_CALL_LIMIT if value is None else value
    if type(value) is not int or not MANUAL_MODEL_CALL_LIMIT <= value <= REPORT_MODEL_CALL_LIMIT_MAX:
        raise ValueError('Report model call limit must be an integer from 128 to 256')
    return value


STAGES = {"preparing", "dependencies", "model_wait", "model_generation", "tool", "test", "checkpoint", "publishing"}
PHASES = {"preparing", "running", "delivering", "finished"}
REASONS = {"model_budget_reserve", "hard_budget", "soft_budget_no_progress", "no_useful_progress", "model_call_limit", "operator_stop",
           "worker_exit", "model_output_limit", "no_changes", "dependencies_failed", "dependencies_changed", "runner_error",
           "tests_failed", "generated_artifacts", "ineligible_task", "runtime_unavailable", "runtime_changed",
           "model_wait_inactive", "model_generation_inactive", "tool_inactive", "test_inactive"}
REASONS.update({"continuation_checkpoint_changed", "github_token_missing", "git_reconciliation", "git_conflict_remaining", "verification_profile_unknown", "progress_history_limit", "model_termination_unverified", "authorization_removed", "queue_window_closed"})
REASONS.update({"coding_model_mismatch", "code_step_blocked", "code_step_scope_changed"})
RESULTS = {"blocked", "review", "local_only"}
TEST_NAMES = {"pytest", "unittest", "jest", "npm_test", "node_test"}
TEST_OUTCOMES = {"passed", "failed", "unknown"}
ARTIFACT_DIRS = {".git", ".review-work", "node_modules", ".lab", ".npmcache", ".npm-cache", ".cache", ".dsh",
                 "coverage", "dist", "build", "test-results", "__pycache__", ".pytest_cache"}
STAGE_LIMITS = {"model_wait": 22 * 60, "model_generation": 30 * 60, "tool": 15 * 60, "test": 40 * 60}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def artifact(path: str) -> bool:
    parts = Path(path).parts
    return bool(set(parts) & ARTIFACT_DIRS or (parts and re.fullmatch(r"session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?", parts[-1])))


def session_logs(home: Path):
    """Read only the highest committed plaintext generation of each session."""
    selected = {}
    for path in (home / ".dsh/progress-sessions").glob("**/session*.jsonl"):
        match = re.fullmatch(r"session(?:\.v([1-9]\d*))?\.jsonl", path.name)
        if not match or path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(home.resolve()):
            continue
        version = int(match[1] or 0)
        if path.parent not in selected or version > selected[path.parent][0]:
            selected[path.parent] = (version, path)
    return [path for _, path in selected.values()]


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


def timeout_command(tokens: list[str]) -> list[str]:
    """Recognize GNU timeout wrappers without executing or guessing shell text."""
    duration = r"\d+(?:\.\d+)?[smhd]?"
    for _ in range(4):
        if not tokens or Path(tokens[0]).name != "timeout":
            return tokens
        index = 1
        while index < len(tokens) and tokens[index].startswith("-"):
            option = tokens[index]
            index += 1
            if option == "--":
                break
            if option in {"--foreground", "--preserve-status", "--verbose", "-v"}:
                continue
            flag, separator, value = option.partition("=")
            if flag not in {"-k", "--kill-after", "-s", "--signal"}:
                return []
            if not separator:
                if index >= len(tokens):
                    return []
                value = tokens[index]
                index += 1
            if flag in {"-k", "--kill-after"}:
                if not re.fullmatch(duration, value):
                    return []
            else:
                try:
                    signal.Signals(int(value) if value.isdigit() else getattr(signal, "SIG" + value.removeprefix("SIG")))
                except (AttributeError, ValueError):
                    return []
        if index >= len(tokens) or not re.fullmatch(duration, tokens[index]):
            return []
        tokens = tokens[index + 1:]
    return []


def test_command(command: str) -> tuple[str, bool] | None:
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
        timed = bool(tokens and Path(tokens[0]).name == "timeout")
        tokens = timeout_command(tokens)
        if not tokens:
            continue
        exe = Path(tokens[0]).name
        if exe in {"pytest", "pytest-3"}:
            return "pytest", timed
        if exe in {"python", "python3"} and tokens[1:3] in [["-m", "pytest"], ["-m", "unittest"]]:
            return tokens[2], timed
        if exe in {"jest", "npx"} and (exe == "jest" or tokens[1:2] == ["jest"]):
            return "jest", timed
        if exe in {"npm", "pnpm", "yarn"} and any(re.fullmatch(r"test(?::[\w-]+)?", t) for t in tokens[1:3]):
            return "npm_test", timed
        if exe == "node" and any(t.endswith("run-jest.js") or Path(t).parts[-3:] == ("jest", "bin", "jest.js") for t in tokens[1:2]):
            return "jest", timed
        if exe == "node" and "--test" in tokens:
            return "node_test", timed
    return None


def test_kind(command: str) -> str | None:
    match = test_command(command)
    return match[0] if match else None


def test_identity(command: str) -> str:
    """Ignore output presentation, retaining test arguments and execution context."""
    # Do not guess at substitutions or unknown additional commands.
    if "$(" in command or "`" in command or "\n" in command or "\r" in command:
        return hashlib.sha256(command.encode()).hexdigest()
    viewers = {"cat", "head", "tail", "grep", "wc", "tee"}
    quote, escaped, redirect = None, False, None
    end = len(command)
    for index, char in enumerate(command):
        if escaped:
            escaped = False
        elif char == "\\" and quote != "'":
            escaped = True
        elif quote:
            if char == quote:
                quote = None
        elif char in {"'", '"'}:
            quote = char
        elif char == "|":
            # || is another command, rather than an output display pipeline.
            tail = command[index + 1:]
            try:
                lexer = shlex.shlex(tail, posix=True, punctuation_chars="|;&<>")
                lexer.whitespace_split = True
                lexer.commenters = ""
                display = list(lexer)
            except ValueError:
                display = []
            starts = [0] + [i + 1 for i, word in enumerate(display) if word == "|"]
            if (command[index:index + 2] == "||" or not display or
                    any(i >= len(display) or display[i] not in viewers for i in starts) or
                    any(re.fullmatch(r"[|;&<>]+", word) and word != "|" for word in display) or
                    ";" in tail or "&&" in tail or "||" in tail):
                return hashlib.sha256(command.encode()).hexdigest()
            end = index
            break
        elif char == ";":
            tail = command[index + 1:]
            try:
                display = shlex.split(tail)
            except ValueError:
                display = []
            if (redirect is None or not display or display[0] not in viewers or
                    any(char in tail for char in ";&|")):
                return hashlib.sha256(command.encode()).hexdigest()
            end = index
            break
        elif char == ">" and redirect is None:
            descriptor = re.search(r"(?<!\S)\d+$", command[:index])
            redirect = descriptor.start() if descriptor else index
    stem = command[:end]
    if redirect is not None:
        target = r"(?:'[^']*'|\"[^\"$`]*\"|(?:\\.|[^\s<>|;&()\\])+)"
        suffix = rf"(?:[12]?>>?&?\s*{target}\s*)+"
        if re.fullmatch(suffix, stem[redirect:]):
            stem = stem[:redirect]
    try:
        # Quoting changes expansions; keep their original spelling conservatively.
        if any(char in stem for char in "$*?[]~{}"):
            return hashlib.sha256(command.encode()).hexdigest()
        # Validate quoting without erasing shell operators, quotes or escapes.
        shlex.split(stem)
        payload = stem.strip()
    except ValueError:
        payload = command
    return hashlib.sha256(payload.encode()).hexdigest()


def tool_message(message: dict) -> tuple[str, bool, bool]:
    """Extract bounded harness text and errors; malformed evidence stays unknown."""
    if not isinstance(message, dict) or type(message.get("isError", False)) is not bool:
        return "", False, False
    stack = [(message.get("content", ""), 0)]
    text, errored, visited, size = [], message.get("isError", False), 0, 0
    while stack:
        content, depth = stack.pop()
        visited += 1
        if depth > 64 or visited > 4096:
            return "", False, False
        if isinstance(content, str):
            try:
                decoded = json.loads(content)
            except ValueError:
                decoded = None
            except RecursionError:
                return "", False, False
            # Only harness blocks are envelopes. Arbitrary JSON is plain output.
            if isinstance(decoded, list) and any(isinstance(item, dict) and "type" in item for item in decoded):
                content = decoded
            else:
                size += len(content)
                if size > 4 * 1024 * 1024:
                    return "", False, False
                text.append(content)
                continue
        if not isinstance(content, list) or len(content) + visited + len(stack) > 4096:
            return "", False, False
        children = []
        for item in content:
            if not isinstance(item, dict) or type(item.get("isError", False)) is not bool:
                return "", False, False
            errored = errored or item.get("isError", False)
            if item.get("type") == "tool-result" and "content" in item:
                children.append((item["content"], depth + 1))
            elif item.get("type") == "text" and isinstance(item.get("text"), str):
                children.append((item["text"], depth + 1))
            else:
                return "", False, False
        stack.extend(reversed(children))
    return "\n".join(text), errored, True


def message_text(message: dict) -> str:
    return tool_message(message)[0]


def test_outcome(content: str, errored: bool, reliable_exit: bool, timed: bool = False) -> str:
    """A successful output filter does not prove the test before it passed."""
    content = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", content)
    if re.search(r"\[(?:timed out|killed by signal)", content):
        return "unknown"
    if timed and any(len(code) > 3 or int(code) >= 124 for code in re.findall(r"\[exit code: (\d+)\]", content)):
        return "unknown"  # timeout/launcher failure or ambiguous signal termination
    failures = (r"(?m)^\s*(?:FAILED\b|FAIL(?:\s|$)|"
                r"(?:Test Suites|Tests):[^\n]*\b[1-9]\d* failed\b|"
                r"# fail [1-9]\d*\b|=+[^\n]*\b[1-9]\d* failed\b)")
    if errored or re.search(r"\[exit code: [1-9]\d*\]", content) or re.search(failures, content):
        return "failed"
    success = r"(?m)^\s*(?:OK\b|Test Suites:[^\n]*\b[1-9]\d* passed\b|# fail 0\b|=+[^\n]*\b[1-9]\d* passed\b)"
    return "passed" if reliable_exit or re.search(success, content) else "unknown"


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
    if "modelCallLimit" in value:
        item = value["modelCallLimit"]
        result["modelCallLimit"] = item if type(item) is int and MANUAL_MODEL_CALL_LIMIT <= item <= REPORT_MODEL_CALL_LIMIT_MAX else None
    result["stopReason"] = allowed(value.get("stopReason"), REASONS)
    result["result"] = allowed(value.get("result"), RESULTS)
    result["currentTest"] = allowed(value.get("currentTest"), TEST_NAMES)
    last = value.get("lastTest")
    result["lastTest"] = ({"name": last["name"], "outcome": last["outcome"]}
                          if isinstance(last, dict) and allowed(last.get("name"), TEST_NAMES) and allowed(last.get("outcome"), TEST_OUTCOMES) else None)
    checkpoint = value.get("checkpoint")
    result["checkpoint"] = checkpoint if isinstance(checkpoint, str) and re.fullmatch(r"[a-f0-9]{40}", checkpoint) else None
    result["coreRecorded"] = value.get("coreRecorded") is True
    result["preflight"] = value.get("preflight") is True
    useful_work = value.get("lastUsefulWorkSeconds")
    result["lastUsefulWorkSeconds"] = useful_work if type(useful_work) is int and 0 <= useful_work <= 86400 else None
    usage = value.get("usage") or {}
    result["usage"] = {k: v for k, v in usage.items() if k in {"workSeconds", "testSeconds", "modelSeconds", "modelCalls"}
                       and type(v) is int and 0 <= v <= 86400}
    for field in ["seenStates", "seenTests"]:
        items = value.get(field, [])
        result[field] = [v for v in items[:256] if isinstance(v, str) and re.fullmatch(r"[a-f0-9]{64}", v)] if isinstance(items, list) else []
    steps = value.get("reportSteps")
    if isinstance(steps, dict):
        count = lambda item: item if type(item) is int and 0 <= item <= 100000 else None
        tally = steps.get("counts") if isinstance(steps.get("counts"), dict) else {}
        result["reportSteps"] = {
            "done": count(steps.get("done")), "failed": count(steps.get("failed")), "findings": count(steps.get("findings")),
            "escalated": count(steps.get("escalated")),
            "stepContext": count(steps.get("stepContext")),
            "budgetSource": allowed(steps.get("budgetSource"), {"agent_workload", "speed_knee", "default"}),
            "counts": {key: count(tally.get(key)) for key in ("reviewed", "partial", "blocked", "pending")}}
    if "codeSteps" in value:
        result["codeSteps"] = coding_step_progress.project(value["codeSteps"])
    manual = value.get("manualHead")
    result["manualHead"] = manual if isinstance(manual, str) and re.fullmatch(r"[a-f0-9]{40}", manual) else None
    pr = value.get("pr")
    if isinstance(pr, dict) and type(pr.get("number")) is int and 1 <= pr["number"] <= 1000000:
        expected = f"agentx/coding-task-{task_id}"
        repo = pr.get("repository", "")
        if (re.fullmatch(r"[\w.-]+/[\w.-]+", repo) and pr.get("branch") == expected and pr.get("base") == "main"
                and pr.get("head") == result["checkpoint"] and pr.get("url") == f"https://github.com/{repo}/pull/{pr['number']}"):
            result["pr"] = {k: pr[k] for k in ["repository", "number", "branch", "base", "head", "url"]}
            if re.fullmatch(r'[a-f0-9]{64}', str(pr.get('diffFingerprint', ''))):
                result['pr']['diffFingerprint'] = pr['diffFingerprint']
    return result


class Progress:
    def __init__(self, task_id: str, request_id: str = "", soft_seconds: int = 7200,
                 *, receipts: Path | None = None, heartbeat=None, now=time.monotonic):
        self.task_id, self.request_id, self.now, self.heartbeat = task_id, request_id, now, heartbeat
        self.path = receipts / f"{request_id}.progress.json" if receipts and request_id else None
        self.stop_path = receipts / f"{request_id}.stop.json" if receipts and request_id else None
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
        self.accounted_at = self.started
        self.stage_spent = {"testSeconds": 0.0, "modelSeconds": 0.0}
        self.cumulative_limits = None
        self.model_worker_active = False
        self.queue_deadline = float("inf")
        self.core_recorded = False
        self.pr = self.manual_head = None
        self.prior_work = self.useful_work = 0
        self.write()

    def carry(self, manifest):
        self.cumulative_limits = manifest["remaining"]
        if manifest.get("queueEndAt"):
            self.queue_deadline = self.now() + max(0, datetime.fromisoformat(manifest["queueEndAt"].replace("Z", "+00:00")).timestamp() - datetime.now(timezone.utc).timestamp())
        self.hard_deadline = self.started + self.cumulative_limits["workSeconds"]
        self.soft_deadline = min(self.soft_deadline, self.hard_deadline)
        self.seen_states.update(manifest.get("seenStates", []))
        self.seen_tests.update(manifest.get("seenTests", []))
        self.no_progress_limit = manifest["limits"]["noProgressSeconds"]
        self.prior_work = manifest.get("spent", {}).get("workSeconds", 0)
        self.useful_work = manifest.get("lastUsefulWorkSeconds", 0)
        self.last_useful = self.started - max(0, self.prior_work - max(self.useful_work, manifest.get("progressWindowStartedAtWorkSeconds", 0)))
        self.write()

    def account(self):
        current = self.now()
        elapsed = max(0, current - self.accounted_at)
        if self.stage == "test":
            self.stage_spent["testSeconds"] += elapsed
        elif self.stage in {"model_wait", "model_generation"}:
            self.stage_spent["modelSeconds"] += elapsed
        self.accounted_at = current

    def usage(self):
        self.account()
        return {"workSeconds": max(0, int(self.now() - self.started)), "modelCalls": self.model_calls,
                **{k: int(v) for k, v in self.stage_spent.items()}}

    def model_remaining(self):
        self.account()
        return max(0, self.cumulative_limits["modelSeconds"] - self.stage_spent["modelSeconds"])

    def test_remaining(self):
        return max(0, (self.cumulative_limits or {"testSeconds": STAGE_LIMITS["test"]})["testSeconds"] - self.stage_spent["testSeconds"])

    def call_limit(self):
        if self.cumulative_limits:
            return self.cumulative_limits["modelCalls"]
        return report_call_limit(getattr(self, "report_model_call_limit", None)) if getattr(self, "report_mode", False) else MANUAL_MODEL_CALL_LIMIT

    def model_guidance(self):
        """Read an advisory snapshot without touching billing or progress timers."""
        if self.phase != "running" or self.stop_reason:
            return None
        step = getattr(self, "step", None)
        if step:
            current = self.now()
            prefix = ("Runner-owned step budget before this request: " + json.dumps({
                "modelCalls": max(0, step["calls"] - (self.model_calls - step["startCalls"])),
                "seconds": max(0, int(step["deadline"] - current))}, sort_keys=True)
                + ". ")
            if step.get("resultKind") == "source":
                return prefix + "Finish only the assigned source step before it runs out; do not commit or expand scope."
            return (prefix + f"Write your JSON result to {step['output']} before it runs out; a truthful partial result is "
                    "accepted." + (" Sources remain read-only." if getattr(self, "role_read_only", False) else ""))
        if getattr(self, "report_mode", False) and not self.cumulative_limits:
            current = self.now()
            remaining = {"workSeconds": max(0, int(min(self.hard_deadline, self.queue_deadline) - current)),
                "softSeconds": max(0, int(self.soft_deadline - current)),
                "modelCalls": max(0, self.call_limit() - self.model_calls),
                "noProgressSeconds": max(0, int(getattr(self, "no_progress_limit", 45 * 60) - (current - self.last_useful)))}
            return ("Runner-owned report budget estimate before this request (seconds, except modelCalls): " +
                    json.dumps(remaining, sort_keys=True) +
                    ". The observed call count can lag; this request consumes a call. Core enforces the exact " +
                    str(self.call_limit()) + "-request limit. This advisory grants no extra budget or authorization. "
                    "Save verified findings in the private Markdown report after each group; keep pending scope explicit. "
                    "Before opening another group, read back the saved coverage, synchronize its summary counts and record the next group. "
                    "Sources remain read-only. Finish with a saved honest report before exhaustion. " +
                    ("Few calls remain: save your current report and end now." if remaining["modelCalls"] <= 8 else ""))
        if not self.cumulative_limits:
            current = self.now()
            remaining = {'workSeconds': max(0, int(min(self.hard_deadline, self.queue_deadline) - current)),
                         'softSeconds': max(0, int(self.soft_deadline - current)),
                         'modelCalls': max(0, self.call_limit() - self.model_calls)}
            return ('Runner-owned code budget estimate before this request (seconds, except modelCalls): ' +
                    json.dumps(remaining, sort_keys=True) +
                    '. The observed count can lag; this request consumes a call. Time does not replenish model calls. '
                    'Make the smallest source correction, run focused tests, and leave a useful checkpoint before exhaustion. ' +
                    ('Few calls remain: finish the current work and end now.' if remaining['modelCalls'] <= 8 else ''))
        current, stage = self.now(), self.stage
        elapsed = max(0, current - self.accounted_at)
        remaining = {"workSeconds": max(0, int(min(self.hard_deadline, self.queue_deadline) - current)),
            "modelSeconds": max(0, int(self.cumulative_limits["modelSeconds"] - self.stage_spent["modelSeconds"]
                                      - (elapsed if stage in {"model_wait", "model_generation"} else 0))),
            "testSeconds": max(0, int(self.cumulative_limits["testSeconds"] - self.stage_spent["testSeconds"]
                                     - (elapsed if stage == "test" else 0))),
            "modelCalls": max(0, self.cumulative_limits["modelCalls"] - self.model_calls),
            "noProgressSeconds": max(0, int(self.no_progress_limit - (current - self.last_useful)))}
        return ("Runner-owned budget update before this request (seconds, except modelCalls): " +
                json.dumps(remaining, sort_keys=True) +
                ". This advisory grants no authorization or extra budget. Model time includes reasoning. "
                "Reading and repeated diagnostics do not count as useful progress. "
                "Make the next necessary source correction and run focused tests; finish before these limits.")

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
        value.update(preflight=getattr(self, "preflight", False), coreRecorded=self.core_recorded, usage=self.usage(), pr=self.pr, manualHead=self.manual_head,
                     seenStates=sorted(self.seen_states), seenTests=sorted(self.seen_tests),
                     lastUsefulWorkSeconds=int(self.useful_work))
        if not self.cumulative_limits:
            value['modelCallLimit'] = self.call_limit()
        if getattr(self, "report_steps", None):
            value["reportSteps"] = self.report_steps
        if getattr(self, "code_steps", None):
            value["codeSteps"] = coding_step_progress.project(self.code_steps)
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=self.path.parent, prefix=".progress-", delete=False) as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
            temporary = output.name
        os.replace(temporary, self.path)

    def set_stage(self, stage: str):
        self.account()
        if self.stage != stage:
            self.stage, self.stage_since = stage, self.now()
        self.last_activity, self.activity_at = self.now(), utc_now()

    def useful(self):
        if len(self.seen_states) > 256 or len(self.seen_tests) > 256:
            self.stop_reason = "progress_history_limit"
            return
        self.last_useful, self.progress_at = self.now(), utc_now()
        self.useful_work = self.prior_work + max(0, self.now() - self.started)

    def event(self, entry: object, session: str = ""):
        if not isinstance(entry, dict) or not isinstance(entry.get("data"), dict):
            return
        kind, data = entry.get("type"), entry["data"]
        if kind in {"step/start", "request/header"}:
            self.set_stage("model_wait")
        elif kind in {"assistant/chunk", "assistant/message"}:
            self.set_stage("model_generation")
        elif kind == "turn/end" and isinstance(data.get("reason"), dict) and data["reason"].get("kind") == "max-tokens":
            if getattr(self, 'step', None): self.step['failure'] = 'model_output_limit'
            else: self.stop_reason = self.stop_reason or "model_output_limit"
        elif kind == "tool/call":
            args = data.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (ValueError, RecursionError):
                    args = {}
            test = test_command(str(args.get("command", ""))) if isinstance(args, dict) and data.get("name") == "bash" else None
            call_id = data.get("callId")
            if isinstance(call_id, str) and test:
                command = str(args.get("command", ""))
                # Shell pipelines and fallbacks can mask the test's exit code.
                reliable = not re.search(r"[|;]", command)
                self.pending_tests[(session, call_id)] = (test[0], test_identity(command), reliable, test[1])
            self.current_test = next(iter(self.pending_tests.values()))[0] if self.pending_tests else None
            self.set_stage("test" if self.current_test else "tool")
        elif kind == "tool/result":
            message = data.get("message") or {}
            if not isinstance(message, dict):
                return
            source = message.get("source") or {}
            call_id = message.get("toolCallId") or (source.get("callId") if isinstance(source, dict) else None)
            if not isinstance(call_id, str) or (isinstance(source, dict) and source.get("callId", call_id) != call_id):
                return
            pending = self.pending_tests.pop((session, call_id), None)
            if pending:
                content, errored, valid = tool_message(message)
                outcome = test_outcome(content, errored, pending[2], pending[3]) if valid else "unknown"
                signature = hashlib.sha256(json.dumps([pending[1], outcome, self.source_signature]).encode()).hexdigest()
                if outcome != "unknown" and signature not in self.seen_tests:
                    self.seen_tests.add(signature)
                    self.useful()
                self.last_test = {"name": pending[0], "outcome": outcome}
            self.current_test = next(iter(self.pending_tests.values()))[0] if self.pending_tests else None
            self.set_stage("test" if self.current_test else "model_wait")

    def baseline(self, home: Path, workspace: Path):
        for path in session_logs(home):
            self.offsets[path] = path.stat().st_size
        self.source_signature = self.observed_state(workspace)
        self.seen_states.add(self.source_signature)

    def scan(self, home: Path, workspace: Path):
        self.source_signature = self.observed_state(workspace)
        if self.source_signature not in self.seen_states:
            self.seen_states.add(self.source_signature)
            self.useful()
        for path in session_logs(home):
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
                    except (ValueError, UnicodeDecodeError, RecursionError):
                        continue
            self.offsets[path] = offset

    def observed_state(self, workspace: Path) -> str:
        signature = source_state(workspace)
        observer = getattr(self, 'report_observer', None)
        return hashlib.sha256((signature + observer()).encode()).hexdigest() if observer else signature

    def observe(self, home: Path | None = None, workspace: Path | None = None):
        while not self.model_events.empty():
            if self.model_events.get() == "model_request":
                self.model_calls += 1
                self.set_stage("model_wait")
        if home and workspace:
            self.scan(home, workspace)

    def tick(self, home: Path | None = None, workspace: Path | None = None):
        self.check_stop()
        self.observe(home, workspace)
        current = self.now()
        self.account()
        if self.last_heartbeat is None or current - self.last_heartbeat >= 20:
            if self.heartbeat:
                try:
                    self.heartbeat()
                except (OSError, RuntimeError):
                    pass
            self.last_heartbeat, self.heartbeat_at = current, utc_now()
        if (self.phase == "running" or self.cumulative_limits and self.phase != "finished") and not self.stop_reason:
            if current >= self.soft_deadline and current < self.hard_deadline:
                if self.last_useful > self.last_extension and current - self.last_useful < min(1800, self.extension_seconds):
                    self.soft_deadline = min(self.hard_deadline, current + self.extension_seconds)
                    self.last_extension = current
                    self.extensions += 1
            if current >= self.hard_deadline:
                self.stop_reason = "hard_budget"
            elif current >= self.soft_deadline:
                self.stop_reason = "soft_budget_no_progress"
            elif self.model_calls >= self.call_limit() and not getattr(self, 'step', None):
                self.stop_reason = "model_call_limit"
            elif self.cumulative_limits and (self.stage_spent["modelSeconds"] >= self.cumulative_limits["modelSeconds"]
                                             or self.stage_spent["testSeconds"] >= self.cumulative_limits["testSeconds"]):
                self.stop_reason = "hard_budget"
            elif self.cumulative_limits and self.model_worker_active and self.model_remaining() <= min(120, self.cumulative_limits["modelSeconds"] // 4):
                self.stop_reason = "model_budget_reserve"
            elif self.stage in STAGE_LIMITS and current - self.stage_since >= STAGE_LIMITS[self.stage]:
                self.stop_reason = f"{self.stage}_inactive"
            elif self.stage != "test" and current - self.last_useful >= getattr(self, "no_progress_limit", 45 * 60):
                self.stop_reason = "no_useful_progress"
        self.write()
        return self.stop_reason or self.step_due(current)

    def begin_step(self, calls: int, seconds: int, output: str, *, result_kind: str = "json"):
        """Bound the next worker session as one report step (#834).

        A step that reaches its calls or time ends that session only; the
        execution's own limits and stop reasons are unchanged."""
        if result_kind not in {"json", "source"}:
            raise ValueError("Runner-owned step result kind is invalid")
        self.step = {"calls": calls, "startCalls": self.model_calls, "deadline": self.now() + seconds,
                     "output": output, "resultKind": result_kind}

    def end_step(self):
        self.last_step_failure = (getattr(self, 'step', None) or {}).get('failure')
        self.step = None

    def step_due(self, current=None):
        step = getattr(self, 'step', None)
        if not step: return None
        return step.get('failure') or ('step_limit' if (self.now() if current is None else current) >= step['deadline'] else None)

    def relay_call_budget(self):
        step = getattr(self, 'step', None)
        if not step:
            return None
        remaining = min(self.call_limit() - self.model_calls, step['calls'] - (self.model_calls - step['startCalls']))
        return {'calls': max(0, remaining), 'key': step['output']}

    def check_stop(self):
        if self.stop_path:
            try:
                if self.stop_path.stat().st_size <= 4096:
                    value = json.loads(self.stop_path.read_text())
                    if (isinstance(value, dict) and value.get("requestId") == self.request_id
                            and value.get("pipelineId") == self.task_id):
                        self.stop_reason = "operator_stop"
            except (OSError, ValueError):
                pass
        return self.stop_reason

    def finish(self, result: str, reason: str | None = None, checkpoint: str | None = None):
        self.phase, self.result = "finished", result
        self.stop_reason = reason or self.stop_reason
        self.checkpoint = checkpoint
        self.write()
