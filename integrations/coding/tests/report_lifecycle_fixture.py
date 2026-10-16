"""CPU browser-journey adapter: real dispatcher/runner, simulated model and systemd."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import hashlib

if os.environ.get('AGENTX_REPORT_LIFECYCLE_FIXTURE') != '1':
    raise SystemExit('This adapter runs only inside the disposable report lifecycle fixture')

here = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fixture_runner', here / 'coding_run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
control = runner.coding_dispatch_control
root = Path(os.environ['AGENTX_REPORT_FIXTURE_ROOT']).resolve()
runner.WORKSPACES = root / 'workspaces'
original_run = subprocess.run


def fake_worker(workspace, prompt, timeout, progress, *, read_only):
    assert read_only
    name = control.read_receipt(progress.request_id)['reportName']
    output = runner.worker_home(workspace) / 'deliverables' / progress.request_id / name
    original = output.read_bytes() if output.exists() else None
    progress.baseline(runner.worker_home(workspace), workspace)
    runner.request(runner.CORE + '/fixture/inference', {'requestId': progress.request_id, 'pipelineId': progress.task_id})
    progress.model_calls += 1
    if original is None:
        output.write_text('# Partial review\n\nREADME reviewed; operations remain pending.\n')
        result = 124
    else:
        assert original == b'# Partial review\n\nREADME reviewed; operations remain pending.\n'
        output.write_text('# Documentation review\n\nREADME and operations reviewed against the frozen source.\nCoverage: both scoped files reviewed.\n')
        result = 0
    coverage_path = output.parent / 'coverage.json'
    coverage = json.loads(coverage_path.read_text())
    for row in coverage['documents']:
        if original is not None or row['path'] == 'README.md':
            row.update(state='reviewed', evidence=[{'path': row['path'], 'sha256': hashlib.sha256((workspace / row['path']).read_bytes()).hexdigest(),
                'line': 1, 'check': 'Verified the synthetic source header in this CPU fixture.'}])
    coverage_path.write_text(json.dumps(coverage))
    progress.observe(runner.worker_home(workspace), workspace)
    return subprocess.CompletedProcess([], result, stdout='Synthetic model fixture finished.', stderr='')


def native_run(command, *args, **kwargs):
    if command[0] == 'systemctl':
        active=(root/'native-active').exists()
        return subprocess.CompletedProcess(command,0 if active else 3,stdout='active\n' if active else 'inactive\n',stderr='')
    if command[0] == 'systemd-run':
        index = command.index(str(here / 'coding_run.py'))
        (root/'native-active').write_text(json.dumps({'requestId': command[command.index('--request-id')+1]}))
        output = (root/'native-worker.log').open('ab')
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--fixture-worker', *command[index+1:]],
                                   stdout=output, stderr=output, start_new_session=True)
        output.close()
        (root/'native-active').write_text(json.dumps({'pid': process.pid}))
        return subprocess.CompletedProcess(command, 0, stdout='', stderr='')
    return original_run(command, *args, **kwargs)


subprocess.run = native_run
runner.run_worker = fake_worker
if sys.argv[1:2] == ['--fixture-worker']:
    sys.argv = [str(here/'coding_run.py'), *sys.argv[2:]]
    try:
        runner.main()
    finally:
        (root/'native-active').unlink(missing_ok=True)
else:
    sys.argv = [str(here/'coding_dispatch_control.py'), *sys.argv[1:]]
    control.main()
