#!/usr/bin/env python3
"""Run one Pipeline task with the local coding worker and open a draft PR.

The worker (DSH) gets a fresh clone on its own branch, a shell and the test
tools inside a Bubblewrap sandbox: it sees that clone and nothing else of the
host, no credentials, and it cannot push. It reaches the model through Core, so
Core admits each inference like any other. Review of the draft PR and its CI is
the gate.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


HERE = Path(__file__).resolve().parent
CORE = os.environ.get("AGENTX_CORE_URL", "http://127.0.0.1:3180").rstrip("/")
REPOSITORY = os.environ.get("AGENTX_CODING_REPOSITORY", "WindriderQc/AgentX")
BASE_BRANCH = os.environ.get("AGENTX_CODING_BASE_BRANCH", "main")
MODEL = os.environ.get("AGENTX_CODING_MODEL", "")
MODEL_URL = os.environ.get("AGENTX_CODING_MODEL_URL", f"{CORE}/api/hermes-openai/patient/v1")
WORKSPACES = Path.home() / "dsh-workspaces"
DSH_ROOT = Path(os.environ.get("AGENTX_DSH_ROOT", str(Path.home() / "dsh")))
NODE_ROOT = Path(os.environ.get("AGENTX_NODE_BIN") or shutil.which("node") or "/usr/local/bin/node").resolve().parents[1]
TASK_ID = re.compile(r"^[0-9]{4}$")
WORKER = "coding-team"
RETRY_WAIT_SECONDS = 120
AUTHOR = ["-c", "user.name=AgentX Coding Team", "-c", "user.email=coding-team@agentx.invalid"]

PROMPT = """You are the AgentX coding worker. /workspace is a fresh clone of {repository}
on branch {branch}. You have a shell: read the code, edit any file the task needs,
install dependencies and run the relevant tests until they pass.

Read AGENTS.md first and follow it. Do not commit or push; that happens after you
finish. End with a short summary: what you changed, the exact test commands you ran
and their results, and anything you could not finish.

# Task {task_id}: {title}

{spec}

# Discussion on the ticket so far

{discussion}

# Why this work matters (Planning, reference only)

{planning}
"""


def request(url: str, body: dict | None = None, token: str = "") -> dict:
    headers = {"Accept": "application/json", "x-service-caller": "coding-run"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    call = Request(url, data=json.dumps(body).encode() if body is not None else None,
                   headers=headers, method="POST" if body is not None else "GET")
    try:
        with urlopen(call, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"{url}: HTTP {error.code} {error.read(500).decode(errors='replace')}") from error


SETTINGS = """llm-pi-ai:
  providers:
    agentx-core:
      displayName: AgentX Core
      apiKeyEnv: AGENTX_CORE_API_KEY
      api: openai-completions
      baseURL: {url}
      models:
        - id: {model}
agent-default-model:
  provider: agentx-core
  model: {model}
"""


def run_worker(workspace: Path, prompt: str, timeout_seconds: int) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory(prefix="agentx-coding-home-") as home:
        (Path(home) / ".dsh").mkdir()
        (Path(home) / ".dsh/settings.yaml").write_text(SETTINGS.format(url=MODEL_URL, model=MODEL))
        sandbox = [
            "timeout", "-k", "30", str(timeout_seconds),
            "bwrap", "--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--clearenv",
            "--setenv", "HOME", "/home/agent", "--setenv", "USER", "agent",
            "--setenv", "PATH", "/opt/node/bin:/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
            "--setenv", "DSH_HOME", "/home/agent/.dsh", "--setenv", "DSH_PERMISSION_MODE", "workspace-write",
            "--setenv", "DSH_TELEMETRY_MODE", "DISABLED", "--setenv", "AGENTX_CORE_API_KEY", "local-no-auth",
            "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
            "--symlink", "usr/bin", "/bin", "--dir", "/etc",
            *(arg for name in ("hosts", "resolv.conf", "nsswitch.conf", "ssl", "passwd", "group")
              for arg in ("--ro-bind", f"/etc/{name}", f"/etc/{name}")),
            "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/home",
            "--bind", home, "/home/agent", "--ro-bind", str(NODE_ROOT), "/opt/node",
            "--ro-bind", str(DSH_ROOT), "/opt/dsh", "--ro-bind", str(HERE / "guard.patch.yml"), "/opt/guard.patch.yml",
            "--bind", str(workspace), "/workspace", "--chdir", "/workspace",
            "/opt/dsh/node_modules/.bin/dsh", "--profile", "headless", "--patch", "/opt/guard.patch.yml", "--", prompt,
        ]
        return subprocess.run(sandbox, text=True, capture_output=True)


def git(workspace: Path, *args: str, env: dict | None = None) -> str:
    return subprocess.run(["git", "-C", str(workspace), *args], check=True, text=True,
                          capture_output=True, env=env).stdout.strip()


def feedback(task_id: str, text: str, status: str | None = None) -> None:
    body = {"by": WORKER, "assignee": WORKER, "text": text}
    if status:
        body["status"] = status
    try:
        request(f"{CORE}/api/pipeline/tasks/{task_id}/feedback", body)
    except (OSError, RuntimeError) as error:
        # The work in the workspace matters more than the note about it.
        print(f"could not record feedback on task {task_id}: {error}", file=sys.stderr)


def push_and_open_pr(workspace: Path, branch: str, task_id: str, title: str, summary: str, token: str) -> str:
    # The token reaches git through the environment only, never the remote URL or disk.
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_COUNT": "1",
           "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
           "GIT_CONFIG_VALUE_0": "Authorization: Basic " + base64.b64encode(
               f"x-access-token:{token}".encode()).decode()}
    git(workspace, "push", f"https://github.com/{REPOSITORY}.git", f"HEAD:refs/heads/{branch}", env=env)
    pulls = f"https://api.github.com/repos/{REPOSITORY}/pulls"
    owner = REPOSITORY.split("/")[0]
    existing = request(f"{pulls}?head={owner}:{branch}&state=open", token=token)
    if existing:
        return existing[0]["html_url"]
    created = request(pulls, {"title": f"{title} (task {task_id})", "head": branch, "base": BASE_BRANCH, "draft": True,
                              "body": f"Pipeline task {task_id}, written by the local coding worker.\n\n"
                                      f"## Worker summary\n\n{summary[-6000:]}"}, token=token)
    return created["html_url"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("task_id")
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    args = parser.parse_args()
    if not TASK_ID.fullmatch(args.task_id):
        parser.error("task id is four digits")
    if not MODEL:
        parser.error("set AGENTX_CODING_MODEL to a model Core serves")

    # The claim makes the task visibly in progress and refuses a second worker.
    request(f"{CORE}/api/pipeline/tasks/{args.task_id}/claim", {"assignee": WORKER})
    task = request(f"{CORE}/api/pipeline/tasks/{args.task_id}/worker?agent={WORKER}")["data"]["task"]
    name = f"task-{args.task_id}"
    branch = f"agentx/coding-task-{args.task_id}"
    workspace = WORKSPACES / name
    # An existing workspace is a follow-up: the worker continues its own branch.
    if not workspace.exists():
        WORKSPACES.mkdir(mode=0o700, exist_ok=True)
        subprocess.run(["git", "clone", "--quiet", "--branch", BASE_BRANCH,
                        f"https://github.com/{REPOSITORY}.git", str(workspace)], check=True)
        git(workspace, "checkout", "--quiet", "-b", branch)

    discussion = "\n\n".join(f"{entry.get('by', 'someone')}: {entry.get('text', '')}"
                             for entry in (task.get("feedback") or []))
    prompt = PROMPT.format(repository=REPOSITORY, branch=branch, task_id=args.task_id, title=task.get("title", ""),
                           spec=task.get("spec", ""), discussion=discussion or "(none)",
                           planning=(task.get("planningContext") or {}).get("text") or "(none)")
    # The worker stops when Core refuses its inference, for example while another
    # workload holds the model host. Wait and continue in the same workspace
    # instead of giving the task up.
    deadline = time.monotonic() + args.timeout_seconds
    while True:
        run = run_worker(workspace, prompt, max(60, int(deadline - time.monotonic())))
        if run.returncode == 0 or deadline - time.monotonic() < RETRY_WAIT_SECONDS + 120:
            break
        print(f"worker stopped (exit {run.returncode}); continuing in {RETRY_WAIT_SECONDS}s", file=sys.stderr, flush=True)
        time.sleep(RETRY_WAIT_SECONDS)
        prompt = PROMPT.format(repository=REPOSITORY, branch=branch, task_id=args.task_id, title=task.get("title", ""),
                               spec=task.get("spec", ""), discussion=discussion or "(none)",
                               planning=(task.get("planningContext") or {}).get("text") or "(none)") + (
            "\n# You were interrupted\n\nAn earlier run on this task stopped before finishing. Files it changed are "
            f"still in /workspace: inspect `git status` and continue from there. Its last words:\n\n{run.stdout.strip()[-1500:]}\n")
    summary = run.stdout.strip() or run.stderr.strip()[-2000:] or "(the worker printed nothing)"

    git(workspace, "add", "-A")
    if git(workspace, "status", "--porcelain"):
        git(workspace, *AUTHOR, "commit", "--quiet", "-m", f"{task.get('title', 'Coding task')} (task {args.task_id})")
    if git(workspace, "rev-parse", "HEAD") == git(workspace, "rev-parse", f"origin/{BASE_BRANCH}"):
        feedback(args.task_id, f"Coding worker changed nothing (exit {run.returncode}).\n\n{summary[-4000:]}", "blocked")
        print(summary)
        return 1

    if run.returncode != 0:
        # Unfinished work stays on the local branch for the next run; it is not offered for review.
        feedback(args.task_id, f"Coding worker stopped before finishing (exit {run.returncode}). Its partial work is "
                               f"committed on local branch {branch} in {workspace}.\n\n{summary[-4000:]}", "blocked")
        print(summary)
        return 1
    token = os.environ.get("GH_TOKEN", "").strip()
    if token:
        where = push_and_open_pr(workspace, branch, args.task_id, task.get("title", "Coding task"), summary, token)
    else:
        where = f"local branch {branch} in {workspace} (no GH_TOKEN: not pushed)"
    feedback(args.task_id, f"Coding worker finished. Result: {where}\n\n{summary[-4000:]}", "done")
    print(summary)
    print(where)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
