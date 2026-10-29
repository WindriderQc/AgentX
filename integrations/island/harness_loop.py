#!/usr/bin/env python3
"""Keep a one-turn harness playing in one session, inside the agent sandbox.

Codex and Claude loop through a Clawblox Stop hook. DSH headless (`dsh headless`)
and pi print mode (`pi -p`) answer one prompt and exit. This driver runs them turn
after turn in the same session with the auto-continue prompt, which is what the
Stop hook does, and writes every turn as Codex rollout lines. The island runner
(activity, stall recovery) and the replay's Messages panel then read every
harness the same way.

    harness_loop.py --kind dsh|pi --state-dir DIR --prompt TEXT
                    --continue-prompt TEXT [--resume] -- HARNESS ARGV...

Without --resume a new session starts (a context reset). With --resume the
session recorded in DIR/session_id continues with --prompt. The driver never
talks to a model itself and holds no credential: the harness reads its
capability from the environment that Clawblox passes into the sandbox.

Clawblox copies this file into its patch as src/agentx_harness_loop.py; the
AgentX tests check that both copies are identical.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,95}$")
MAX_TEXT = 16 * 1024
BACKOFF_FIRST, BACKOFF_MAX = 5, 120


def stamp() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def bounded(text) -> str:
    text = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + "\n[truncated]"


def blocks_text(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(item.get("text", "") for item in content if isinstance(item, dict) and item.get("type") == "text")


class Rollout:
    """Codex-shaped transcript of one session: session_meta, response_item, event_msg."""

    def __init__(self, directory: Path, session_id: str, kind: str):
        directory.mkdir(parents=True, exist_ok=True)
        self.activity, self.errors = 0, 0
        self.path = directory / f"rollout-{session_id}.jsonl"
        fresh = not self.path.exists()
        self.stream = open(self.path, "a", encoding="utf-8")
        if fresh:
            self.write("session_meta", {"id": session_id, "cwd": os.getcwd(), "originator": "agentx-harness-loop",
                                        "harness": kind})

    def write(self, kind: str, payload: dict) -> None:
        self.stream.write(json.dumps({"timestamp": stamp(), "type": kind, "payload": payload}, ensure_ascii=False) + "\n")
        self.stream.flush()

    def message(self, role: str, text: str) -> None:
        part = "output_text" if role == "assistant" else "input_text"
        self.activity += role == "assistant"
        self.write("response_item", {"type": "message", "role": role, "content": [{"type": part, "text": bounded(text)}]})

    def reasoning(self, text: str) -> None:
        self.activity += 1
        self.write("response_item", {"type": "reasoning", "summary": [{"type": "summary_text", "text": bounded(text)}]})

    def call(self, call_id, name, arguments) -> None:
        self.activity += 1
        self.write("response_item", {"type": "function_call", "call_id": str(call_id or ""), "name": str(name or "tool"),
                                     "arguments": bounded(arguments if isinstance(arguments, str) else json.dumps(arguments))})

    def output(self, call_id, text) -> None:
        self.write("response_item", {"type": "function_call_output", "call_id": str(call_id or ""), "output": bounded(text)})

    def usage(self, input_tokens, output_tokens, cached=0) -> None:
        info = {"input_tokens": int(input_tokens or 0), "output_tokens": int(output_tokens or 0),
                "cached_input_tokens": int(cached or 0)}
        info["total_tokens"] = info["input_tokens"] + info["output_tokens"]
        self.write("event_msg", {"type": "token_count", "info": {"last_token_usage": info}})

    def complete(self, reason: str) -> None:
        self.write("event_msg", {"type": "task_complete", "reason": reason})

    def error(self, message: str) -> None:
        self.errors += 1
        self.write("event_msg", {"type": "error", "message": bounded(message)})

    def close(self) -> None:
        self.stream.close()


def translate_pi(event: dict, out: Rollout) -> None:
    kind = event.get("type")
    if kind == "message_end":
        message = event.get("message") or {}
        if message.get("role") != "assistant":
            return
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and block.get("text"):
                out.message("assistant", block["text"])
            elif block.get("type") == "thinking" and block.get("thinking"):
                out.reasoning(block["thinking"])
            elif block.get("type") == "toolCall":
                out.call(block.get("id"), block.get("name"), block.get("arguments") or {})
        usage = message.get("usage") or {}
        if usage:
            out.usage(usage.get("input"), usage.get("output"), usage.get("cacheRead"))
        if message.get("stopReason") in ("error", "aborted"):
            out.error(message.get("errorMessage") or message.get("stopReason"))
    elif kind == "tool_execution_end":
        result = event.get("result") or {}
        out.output(event.get("toolCallId"), blocks_text(result.get("content")) if isinstance(result, dict) else result)
    elif kind == "agent_settled":
        out.complete("aborted" if event.get("aborted") else "completed")


def translate_dsh(event: dict, out: Rollout) -> None:
    kind = event.get("type")
    if kind == "text" and event.get("text"):
        out.message("assistant", event["text"])
    elif kind in ("reasoning", "thinking") and event.get("text"):
        out.reasoning(event["text"])
    elif kind == "tool_call":
        out.call(event.get("callId"), event.get("tool"), event.get("input") or {})
    elif kind == "tool_result":
        out.output(event.get("callId"), event.get("result", ""))
    elif kind == "error":
        out.error(event.get("message") or json.dumps(event))
    elif kind == "status" and event.get("phase") == "step_end":
        usage = event.get("usage") or {}
        if usage:
            out.usage(usage.get("inputTokens"), usage.get("outputTokens"), usage.get("cachedInputTokens"))
    elif kind == "status" and event.get("phase") == "turn_end":
        reason = event.get("reason") or {}
        out.complete(reason.get("kind", "completed") if isinstance(reason, dict) else str(reason))


TRANSLATE = {"pi": translate_pi, "dsh": translate_dsh}


def session_from_event(kind: str, event: dict) -> str | None:
    if event.get("type") != "session":
        return None
    value = event.get("sessionId") if kind == "dsh" else event.get("id")
    return value if isinstance(value, str) and SESSION_ID.match(value) else None


class Loop:
    def __init__(self, args):
        self.args = args
        self.state = Path(args.state_dir)
        self.state.mkdir(parents=True, exist_ok=True)
        self.session_file = self.state / "session_id"
        self.child = None
        self.stopping = False

    def read_session(self) -> str | None:
        try:
            value = self.session_file.read_text().strip()
        except FileNotFoundError:
            return None
        return value if SESSION_ID.match(value) else None

    def write_session(self, value: str) -> None:
        temp = self.session_file.with_suffix(".tmp")
        temp.write_text(value + "\n")
        os.replace(temp, self.session_file)

    def stop(self, signum, _frame) -> None:
        self.stopping = True
        if self.child and self.child.poll() is None:
            try: self.child.send_signal(signum)
            except ProcessLookupError: pass

    def argv(self, session: str | None) -> list[str]:
        argv = list(self.args.harness)
        if self.args.kind == "pi":
            return [*argv, "--session-id", session, "--", self.prompt]
        return [*argv, *(["--session-id", session] if session else []), "-"]

    def turn(self, session: str | None) -> tuple[int, str | None]:
        out = None
        if session:
            out = Rollout(self.state / "sessions", session, self.args.kind)
            out.message("user", self.prompt)
        self.child = subprocess.Popen(self.argv(session), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=None, text=True, encoding="utf-8", errors="replace")
        try:
            if self.args.kind == "dsh":
                self.child.stdin.write(self.prompt)
            self.child.stdin.close()
        except BrokenPipeError:
            pass
        try:
            for line in self.child.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                found = session_from_event(self.args.kind, event)
                if found and out is None:
                    session = found
                    self.write_session(session)
                    out = Rollout(self.state / "sessions", session, self.args.kind)
                    out.message("user", self.prompt)
                if out is not None:
                    TRANSLATE[self.args.kind](event, out)
                    echo(event)
            code = self.child.wait()
            if code != 0 and out is not None and not self.stopping:
                out.error(f"{self.args.kind} exited with status {code}")
            # A turn without model output or with an error (a refused or failed
            # inference the harness swallowed) pauses like a failed exit:
            # the loop never hammers Core.
            healthy = code == 0 and out is not None and out.activity > 0 and out.errors == 0
            return (0 if healthy else code or 1), session
        finally:
            if out is not None:
                out.close()

    def run(self) -> int:
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(signum, self.stop)
        session = None
        if self.args.resume:
            session = self.read_session()
            if not session:
                print("harness loop: no session to resume", file=sys.stderr)
                return 2
        else:
            self.session_file.unlink(missing_ok=True)
            if self.args.kind == "pi":
                session = str(uuid.uuid4())
                self.write_session(session)
        self.prompt = self.args.prompt
        backoff = 0
        while not self.stopping:
            code, session = self.turn(session)
            if self.stopping:
                break
            if code == 0:
                backoff = 0
            else:
                backoff = min(max(BACKOFF_FIRST, backoff * 2), BACKOFF_MAX)
                print(f"harness loop: {self.args.kind} turn failed (status {code}); retrying in {backoff}s", file=sys.stderr)
                deadline = time.monotonic() + backoff
                while not self.stopping and time.monotonic() < deadline:
                    time.sleep(0.5)
            # The next turn continues the session; a session never opened restarts with the first prompt.
            if session:
                self.prompt = self.args.continue_prompt
        return 0


def echo(event: dict) -> None:
    """One short human line per event for the tmux pane and agent.log."""
    kind = event.get("type")
    text = None
    if kind in ("text", "message_end"):
        message = event.get("message") or {}
        text = event.get("text") or (blocks_text(message.get("content")) if message.get("role") == "assistant" else None)
    elif kind in ("tool_call", "tool_execution_start"):
        text = f"$ {event.get('tool') or event.get('toolName')} {json.dumps(event.get('input') or event.get('args') or {})}"
    if text:
        print(text[:400].replace("\n", " "), flush=True)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--kind", required=True, choices=sorted(TRANSLATE))
    p.add_argument("--state-dir", required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--continue-prompt", required=True)
    p.add_argument("--resume", action="store_true")
    p.add_argument("harness", nargs=argparse.REMAINDER)
    return p


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    if args.harness[:1] == ["--"]:
        args.harness = args.harness[1:]
    if not args.harness or not args.prompt.strip() or not args.continue_prompt.strip():
        parser().error("a harness command, a prompt and a continue prompt are required")
    return Loop(args).run()


if __name__ == "__main__":
    sys.exit(main())
