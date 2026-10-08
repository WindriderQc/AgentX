#!/usr/bin/env python3
"""Run one Pipeline task with the local coding worker and open a draft PR.

The worker (DSH) gets a fresh clone on its own branch, a shell and the test
tools inside a Bubblewrap sandbox: it sees that clone and nothing else of the
host, no credentials, and it cannot push. It has no network: its only way out
is one relay to Core's model route, so Core admits each inference like any
other. Dependencies are installed before it starts. Review of the draft PR and
its CI is the gate.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
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
RECEIPTS = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "agentx/coding-run-requests"
RELAY_PORT = 8377
PACKAGE_DIRS = ("core", "benchmark", "rag", "data")
INSTALL_TIMEOUT_SECONDS = 1800

_spec = importlib.util.spec_from_file_location("model_relay", HERE / "model_relay.py")
model_relay = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(model_relay)
_spec = importlib.util.spec_from_file_location("coding_progress", HERE / "coding_progress.py")
coding_progress = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(coding_progress)
# Same eligibility rule as the Pipeline launch control, so a direct invocation
# of this runner cannot start what the dispatch boundary would refuse.
_spec = importlib.util.spec_from_file_location("coding_dispatch_control", HERE / "coding_dispatch_control.py")
coding_dispatch_control = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(coding_dispatch_control)
AUTHOR = ["-c", "user.name=AgentX Coding Team", "-c", "user.email=coding-team@agentx.invalid"]

PROMPT = """You are the AgentX coding worker. /workspace is a fresh clone of {repository}
on branch {branch}. You have a shell: read the code, edit any file the task needs
and run the relevant tests until they pass.

Keep experiments, logs and caches in /tmp or your home, outside /workspace.
Make the smallest complete change requested. A failed probe is evidence to
investigate, not a reason to repeat the same experiment. Check git diff before
finishing and report the test results, including failures.

Your remaining soft budget is {soft_seconds} seconds; the remaining hard ceiling
is {hard_seconds} seconds. Reading and model activity alone do not extend this
budget. Investigate the relevant path, make the smallest source edit, and run its
focused tests before expanding your investigation. New source or test progress
can extend the soft budget; the hard ceiling never moves. If you cannot finish,
explain the remaining work and stop with a useful source checkpoint.

You have no network. The dependencies of core, benchmark, rag and data are already
installed, and the test database is ready. Do not try to download anything. If the
task needs a new package, add it to the right package.json, explain why in your
summary and stop: the owner approves the installation, then you continue.

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


def sandbox(workspace: Path, home: Path, command: list[str], *, network: bool, timeout_seconds: int) -> list[str]:
    return [
        "timeout", "-k", "30", str(timeout_seconds),
        "bwrap", "--unshare-all", *(["--share-net"] if network else []),
        "--die-with-parent", "--new-session", "--clearenv",
        "--setenv", "HOME", "/home/agent", "--setenv", "USER", "agent",
        "--setenv", "PATH", "/opt/node/bin:/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
        "--setenv", "DSH_HOME", "/home/agent/.dsh", "--setenv", "DSH_PERMISSION_MODE", "workspace-write",
        "--setenv", "DSH_TELEMETRY_MODE", "DISABLED", "--setenv", "AGENTX_CORE_API_KEY", "local-no-auth",
        "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
        "--symlink", "usr/bin", "/bin", "--dir", "/etc",
        *(arg for name in ("hosts", "resolv.conf", "nsswitch.conf", "ssl", "passwd", "group")
          for arg in ("--ro-bind", f"/etc/{name}", f"/etc/{name}")),
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/home",
        "--bind", str(home), "/home/agent", "--ro-bind", str(NODE_ROOT), "/opt/node",
        "--ro-bind", str(DSH_ROOT), "/opt/dsh", "--ro-bind", str(HERE), "/opt/coding",
        "--ro-bind", str(HERE.parent.parent / "shared/testing/prepareMongo.js"), "/opt/prepareMongo.js",
        "--bind", str(workspace), "/workspace", "--ro-bind", str(workspace / ".git"), "/workspace/.git",
        "--chdir", "/workspace", *command,
    ]


def worker_home(workspace: Path) -> Path:
    # Kept between runs of a task: package and test-database caches live there.
    home = workspace.parent / f".home-{workspace.name}"
    home.mkdir(mode=0o700, exist_ok=True)
    return home


def dependency_state(workspace: Path) -> str:
    digest = hashlib.sha256()
    for name in PACKAGE_DIRS:
        for file in ("package.json", "package-lock.json"):
            path = workspace / name / file
            digest.update(f"{name}/{file}\0".encode() + (path.read_bytes() if path.is_file() else b"") + b"\0")
    return digest.hexdigest()


def installed_state(workspace: Path) -> str:
    marker = worker_home(workspace) / "dependencies.sha256"
    return marker.read_text().strip() if marker.is_file() else ""


def install_dependencies(workspace: Path, progress=None) -> None:
    """Install what the package files ask for, with network and without the worker.

    Package install scripts are skipped, and the test database is prepared with
    the runner's own script, so nothing the worker wrote runs while the network
    is open. A changed package file reaches this point only when the owner hands
    the task back, which is the approval.
    """
    state = dependency_state(workspace)
    if state == installed_state(workspace):
        return
    script = "set -e\n" + "".join(
        f"if [ -f {name}/package.json ]; then (cd {name} && "
        "if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund || "
        "npm install --ignore-scripts --no-audit --no-fund; "
        "else npm install --ignore-scripts --no-audit --no-fund; fi); fi\n" for name in PACKAGE_DIRS
    ) + "".join(
        f"if [ -d {name}/node_modules/mongodb-memory-server ]; then (cd {name} && node /opt/prepareMongo.js); fi\n"
        for name in PACKAGE_DIRS)
    home = worker_home(workspace)
    if progress:
        progress.set_stage("dependencies")
    command = sandbox(workspace, home, ["bash", "-c", script], network=True,
                      timeout_seconds=INSTALL_TIMEOUT_SECONDS)
    run = supervise(command, progress)
    if run.returncode:
        raise subprocess.CalledProcessError(run.returncode, command, output=run.stdout, stderr=run.stderr)
    # npm install may have completed the lock file; that result is the installed state.
    (home / "dependencies.sha256").write_text(dependency_state(workspace) + "\n")


def tail(path: Path, size: int = 6000) -> str:
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        stream.seek(max(0, stream.tell() - size))
        return stream.read().decode(errors="replace")


def supervise(command: list[str], progress=None, home=None, workspace=None) -> subprocess.CompletedProcess:
    """Poll the child while retaining raw stdout/stderr outside the repository."""
    with tempfile.TemporaryDirectory(prefix="agentx-coding-output-") as directory:
        stdout, stderr = Path(directory) / "stdout", Path(directory) / "stderr"
        with stdout.open("wb") as out, stderr.open("wb") as err:
            process = subprocess.Popen(command, stdout=out, stderr=err, start_new_session=True)
            try:
                while process.poll() is None:
                    if progress and progress.tick(home, workspace):
                        terminate(process)
                        break
                    time.sleep(2)
            finally:
                if process.poll() is None:
                    terminate(process)
        if progress and home and workspace:
            progress.observe(home, workspace)
        return subprocess.CompletedProcess(command, process.wait(), tail(stdout), tail(stderr))


def terminate(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def run_worker(workspace: Path, prompt: str, timeout_seconds: int, progress=None) -> subprocess.CompletedProcess:
    home = worker_home(workspace)
    (home / ".dsh").mkdir(exist_ok=True)
    (home / ".dsh/settings.yaml").write_text(SETTINGS.format(url=f"http://127.0.0.1:{RELAY_PORT}/v1", model=MODEL))
    if progress:
        progress.baseline(home, workspace)
        progress.set_stage("model_wait")
    relay = model_relay.serve(str(home / "model.sock"), MODEL_URL,
                             progress.model_events.put if progress else None)
    try:
        return supervise(sandbox(workspace, home, [
            "python3", "/opt/coding/model_relay.py", "inside", "/home/agent/model.sock", str(RELAY_PORT), "--",
            "/opt/dsh/node_modules/.bin/dsh", "--profile", "headless", "--patch", "/opt/coding/guard.patch.yml", "--", prompt,
        ], network=False, timeout_seconds=timeout_seconds), progress, home, workspace)
    finally:
        relay.shutdown()
        relay.server_close()


def git(workspace: Path, *args: str, env: dict | None = None) -> str:
    isolated = {**(env or os.environ), "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.run(["git", "-C", str(workspace), "-c", "core.hooksPath=/dev/null",
                           "-c", "core.fsmonitor=false", *args], check=True, text=True,
                          capture_output=True, env=isolated).stdout.strip()


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
    # A local model needs well over an hour to read the code, fix and test a Core change.
    parser.add_argument("--timeout-seconds", type=int, default=7200)
    parser.add_argument("--request-id", default="")
    args = parser.parse_args()
    if not TASK_ID.fullmatch(args.task_id):
        parser.error("task id is four digits")
    if not MODEL:
        parser.error("set AGENTX_CODING_MODEL to a model Core serves")
    if args.request_id and not coding_progress.REQUEST_ID.fullmatch(args.request_id):
        parser.error("request id must be a UUID")
    if not 1 <= args.timeout_seconds <= 43200:
        parser.error("timeout must be between 1 and 43200 seconds")

    progress = coding_progress.Progress(args.task_id, args.request_id, args.timeout_seconds, receipts=RECEIPTS,
        heartbeat=lambda: request(f"{CORE}/api/pipeline/tasks/{args.task_id}/heartbeat", {"assignee": WORKER}))
    try:
        return execute(args, progress)
    except Exception as error:
        progress.finish("blocked", "runner_error", progress.checkpoint)
        feedback(args.task_id, f"Coding runner failed ({type(error).__name__}). Inspect the local workspace and host unit; "
                               "no automatic retry was started.", "blocked")
        print(f"coding runner failed: {type(error).__name__}", file=sys.stderr)
        return 1


def execute(args, progress) -> int:
    # The same eligibility rule as the Pipeline launch control: a direct task id
    # may not start a task the dispatch boundary would refuse, and an ineligible
    # task must stay untouched (no claim, clone, dependency install or worker run).
    task = request(f"{CORE}/api/pipeline/tasks/{args.task_id}")["data"]["task"]
    if not coding_dispatch_control.can_start(task):
        print(f"task {args.task_id} is not a queued, unowned, non-private agentx-coding task; not started", file=sys.stderr)
        return 2

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

    try:
        progress.tick()
        install_dependencies(workspace, progress)
        installed = dependency_state(workspace)
    except subprocess.CalledProcessError as error:
        feedback(args.task_id, "Dependencies could not be installed before the worker started.\n\n"
                               f"{(error.stderr or error.stdout or '')[-3000:]}", "blocked")
        progress.finish("blocked", "dependencies_failed")
        return 1

    discussion = "\n\n".join(f"{entry.get('by', 'someone')}: {entry.get('text', '')}"
                             for entry in (task.get("feedback") or []))
    prompt = PROMPT.format(repository=REPOSITORY, branch=branch, task_id=args.task_id, title=task.get("title", ""),
                           spec=task.get("spec", ""), discussion=discussion or "(none)",
                           planning=(task.get("planningContext") or {}).get("text") or "(none)",
                           soft_seconds=max(0, int(progress.soft_deadline - progress.now())),
                           hard_seconds=max(0, int(progress.hard_deadline - progress.now())))
    # Core's patient route owns capacity waiting. A nonzero worker exit stops
    # this attempt; a later explicit handoff continues its existing workspace.
    progress.phase = "running"
    run = run_worker(workspace, prompt, max(1, int(progress.hard_deadline - progress.now())), progress)
    summary = run.stdout.strip() or run.stderr.strip()[-2000:] or "(the worker printed nothing)"

    progress.phase = "delivering"
    progress.set_stage("checkpoint")
    # Generated session and cache files stay on disk for diagnosis, outside
    # the product checkpoint and every eventual public branch.
    exclusions = [f":(exclude,glob)**/{name}/**" for name in coding_progress.ARTIFACT_DIRS if name != ".git"]
    git(workspace, "add", "-A", "--", ".", *exclusions,
        ":(exclude)**/session.jsonl", ":(exclude)**/session.jsonl.zstd")
    if git(workspace, "diff", "--cached", "--name-only"):
        git(workspace, *AUTHOR, "commit", "--quiet", "-m", f"{task.get('title', 'Coding task')} (task {args.task_id})")
    progress.checkpoint = git(workspace, "rev-parse", "HEAD")
    progress.write()
    if git(workspace, "rev-parse", "HEAD") == git(workspace, "rev-parse", f"origin/{BASE_BRANCH}"):
        feedback(args.task_id, f"Coding worker changed nothing (exit {run.returncode}).\n\n{summary[-4000:]}", "blocked")
        progress.finish("blocked", progress.stop_reason or "no_changes", progress.checkpoint)
        print(summary)
        return 1

    if dependency_state(workspace) != installed:
        # The worker asked for packages it could not download. Handing the task back approves installing them.
        feedback(args.task_id, "The coding worker changed package files and needs them installed before it can "
                               "finish. Review the change on local branch "
                               f"{branch} in {workspace}; hand the task back to the team to approve the "
                               f"installation and let it continue.\n\n{summary[-4000:]}", "blocked")
        progress.finish("blocked", "dependencies_changed", progress.checkpoint)
        print(summary)
        return 1
    if run.returncode != 0 or progress.stop_reason:
        # Unfinished work stays on the local branch for the next run; it is not offered for review.
        feedback(args.task_id, f"Coding worker stopped before finishing (exit {run.returncode}). Its partial work is "
                               f"committed on local branch {branch} in {workspace}.\n\n{summary[-4000:]}", "blocked")
        progress.finish("blocked", progress.stop_reason or "worker_exit", progress.checkpoint)
        print(summary)
        return 1
    if progress.last_test and progress.last_test["outcome"] != "passed":
        feedback(args.task_id, "The last observed test did not pass. The checkpoint stays local; "
                               "correct the failure and rerun the tests before publishing.", "blocked")
        progress.finish("blocked", "tests_failed", progress.checkpoint)
        return 1
    introduced = git(workspace, "diff", "--name-only", f"origin/{BASE_BRANCH}", "HEAD").splitlines()
    if any(coding_progress.artifact(name) for name in introduced):
        feedback(args.task_id, "The branch contains generated runtime artifacts from a previous checkpoint. "
                               "Preserve that checkpoint privately and transfer the source patch to a clean branch.", "blocked")
        progress.finish("blocked", "generated_artifacts", progress.checkpoint)
        return 1
    token = os.environ.get("GH_TOKEN", "").strip()
    progress.set_stage("publishing")
    if token:
        where = push_and_open_pr(workspace, branch, args.task_id, task.get("title", "Coding task"), summary, token)
    else:
        where = f"local branch {branch} in {workspace} (no GH_TOKEN: not pushed)"
    feedback(args.task_id, f"Coding worker finished. Result: {where}\n\n{summary[-4000:]}", "done" if token else "blocked")
    progress.finish("review" if token else "local_only", checkpoint=progress.checkpoint)
    print(summary)
    print(where)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
