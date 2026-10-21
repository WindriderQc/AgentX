"""Carry worker prompts through a private read-only file, never an exec argument."""
from pathlib import Path
import tempfile

SANDBOX_PROMPT = '/tmp/agentx-worker-prompt.txt'


def run(r, workspace, home, prompt, seconds, progress, *, read_only, on_stop):
    # Keep the host file outside the worker's writable home. Bubblewrap exposes
    # only this file, read-only, for the lifetime of the supervised process.
    with tempfile.TemporaryDirectory(prefix='.agentx-worker-input-', dir=home.parent) as directory:
        path = Path(directory) / 'prompt.txt'
        path.write_bytes(prompt.encode('utf-8'))
        path.chmod(0o400)
        command = [
            'python3', '/opt/coding/model_relay.py', 'inside', '/home/agent/model.sock', str(r.relay_port), '--',
            'node', '--require', '/opt/coding/coding_worker_prompt.cjs',
            '/opt/dsh/node_modules/.bin/dsh', SANDBOX_PROMPT, '--profile', 'headless',
            '--patch', '/home/agent/.dsh/agentx.patch.json', '--patch', '/opt/coding/guard.patch.yml', '--',
        ]
        return r.supervise(r.sandbox(workspace, home, command, network=False, timeout_seconds=seconds,
            read_only=read_only, report_request_id=progress.request_id if read_only else '', prompt_file=path),
            progress, home, workspace, on_stop=on_stop)
