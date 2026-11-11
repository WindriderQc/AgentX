"""Private CPU supervisor for a pinned ComfyUI installation.

Core owns admission and business operations. This adapter starts its own CUDA
child only for execution, keeps terminal execution receipts, and releases the
entire CUDA context before Ollama restoration. It never replays a prompt.
"""
import argparse
import email.policy
import email.parser
import ipaddress
import json
import os
import pathlib
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
import hashlib
import stat
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

RESOURCE_CONTRACT = 'agentx.image-worker-resources/v1'
TERMINAL_EVENTS = ('execution_success', 'execution_error', 'execution_interrupted')


def epoch_ms(seconds):
    return int(seconds * 1000)


class ChildLifetime:
    """Resource observations of one CUDA child, from its start to its release.

    Every figure belongs to that child process alone. The supervisor, Core,
    Ollama and any other GPU client are never counted in it.
    """
    def __init__(self, pid, spawned, ready, reserve, interval):
        self.pid, self.spawned, self.ready, self.reserve, self.interval = pid, spawned, ready, reserve, interval
        self.job_ids = []
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.thread = None
        self.samples = {'attempted': 0, 'matched': 0, 'absent': 0, 'failed': 0, 'invalid': 0}
        self.vram_max = self.vram_max_at = self.first_match = self.last_match = None

    def record(self, outcome, mib=None, at=None):
        with self.lock:
            if self.stop.is_set():
                return  # A late reading must not fall after the receipt's release time.
            self.samples['attempted'] += 1
            self.samples[outcome] += 1
            if outcome == 'matched':
                self.first_match = self.first_match or at
                self.last_match = at
                if self.vram_max is None or mib > self.vram_max:
                    self.vram_max, self.vram_max_at = mib, at

    def vram(self):
        with self.lock:
            base = {'method': 'nvidia-smi-compute-apps', 'scope': 'cuda-child-process',
                'intervalMs': int(self.interval * 1000), 'samples': dict(self.samples)}
            if self.vram_max is not None:
                # Sampling can miss the true maximum: this is a lower bound only.
                return {**base, 'status': 'sampled', 'bound': 'lower', 'observedMaxMiB': self.vram_max,
                    'observedMaxAtMs': epoch_ms(self.vram_max_at), 'firstMatchedAtMs': epoch_ms(self.first_match),
                    'lastMatchedAtMs': epoch_ms(self.last_match)}
            reason = ('sampling disabled' if not self.interval else 'no sample taken' if not self.samples['attempted']
                else 'driver query failed' if self.samples['failed'] == self.samples['attempted']
                else 'child process not listed by the driver')
            return {**base, 'status': 'unavailable', 'reason': reason}


class Worker:
    def __init__(self, args):
        self.args = args
        self.root = pathlib.Path(args.root).resolve()
        self.state = pathlib.Path(args.state).resolve()
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.nodes = json.loads(pathlib.Path(args.object_info).read_text())
        self.child = None
        self.lifetime = None
        self.sample_interval = max(0, getattr(args, 'vram_sample_ms', 1000)) / 1000
        self.current_reserve = None
        self.lock = threading.RLock()
        self.upstream = f'http://127.0.0.1:{args.child_port}'
        self.log = open(self.state / 'comfy.log', 'ab', buffering=0)

    def call(self, route, body=None, timeout=15):
        req = urllib.request.Request(self.upstream + route,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}

    def running(self):
        return self.child is not None and self.child.poll() is None

    def start(self, reserve_vram=None):
        if self.running():
            return
        env = {**os.environ, 'CUDA_VISIBLE_DEVICES': str(self.args.gpu),
            'PYTHONDONTWRITEBYTECODE': '1'}
        self.current_reserve = reserve_vram if reserve_vram is not None else self.args.reserve_vram
        spawned = time.time()
        self.child = subprocess.Popen([self.args.python, '-u', 'main.py',
            '--listen', '127.0.0.1', '--port', str(self.args.child_port),
            '--disable-auto-launch', '--disable-api-nodes', '--disable-metadata',
            '--disable-all-custom-nodes', '--disable-dynamic-vram', '--cache-none',
            '--reserve-vram', str(self.current_reserve)], cwd=self.root, env=env,
            stdout=self.log, stderr=self.log, start_new_session=True)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if not self.running():
                raise RuntimeError('CUDA worker failed to start')
            try:
                self.call('/system_stats', timeout=2)
                self.track(spawned)
                return
            except (OSError, urllib.error.URLError):
                time.sleep(.25)
        raise RuntimeError('CUDA worker startup is unverified')

    def track(self, spawned):
        lifetime = ChildLifetime(self.child.pid, spawned, time.time(), self.current_reserve, self.sample_interval)
        if lifetime.interval:
            lifetime.thread = threading.Thread(target=self.sample_vram, args=(lifetime,), daemon=True)
            lifetime.thread.start()
        self.lifetime = lifetime

    def sample_vram(self, lifetime):
        # Never takes the worker lock: sampling cannot delay submission or release.
        while True:
            outcome, mib = self.process_vram(lifetime.pid)
            lifetime.record(outcome, mib, time.time())
            if lifetime.stop.wait(lifetime.interval):
                return

    def process_vram(self, pid):
        """Device memory the NVIDIA driver currently lists for one process."""
        try:
            raw = subprocess.check_output(['nvidia-smi', '-i', str(self.args.gpu),
                '--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return 'failed', None
        for line in raw.strip().splitlines():
            fields = [x.strip() for x in line.split(',')]
            if len(fields) == 2 and fields[0] == str(pid):
                return ('matched', int(fields[1])) if fields[1].isdigit() else ('invalid', None)
        return 'absent', None

    def process_ram_peak(self, pid):
        """Kernel high-water mark of one process's resident memory (Linux VmHWM)."""
        base = {'method': 'linux-proc-vmhwm', 'scope': 'cuda-child-process'}
        try:
            lines = pathlib.Path(f'/proc/{pid}/status').read_text().splitlines()
        except OSError:
            return {**base, 'status': 'unavailable', 'reason': 'process status unreadable'}
        for line in lines:
            if line.startswith('VmHWM:'):
                fields = line.split()
                if len(fields) == 3 and fields[2] == 'kB' and fields[1].isdigit():
                    return {**base, 'status': 'measured', 'peakKiB': int(fields[1])}
                return {**base, 'status': 'invalid', 'reason': 'unexpected VmHWM format'}
        return {**base, 'status': 'unavailable', 'reason': 'VmHWM not reported'}

    def execution_ms(self, job_id):
        """ComfyUI's own start-to-terminal time for one prompt, from its retained status."""
        try:
            messages = json.loads(self.record_path(job_id).read_text())['terminal']['status']['messages']
            stamps = {name: data.get('timestamp') for name, data in messages if isinstance(data, dict)}
        except (OSError, ValueError, KeyError, TypeError):
            return None
        start = stamps.get('execution_start')
        end = next((stamps[name] for name in TERMINAL_EVENTS if name in stamps), None)
        valid = all(isinstance(x, int) and not isinstance(x, bool) for x in (start, end))
        return end - start if valid and end >= start else None

    def resources(self, lifetime, ram):
        """Release receipt for one child lifetime; returned by /free and kept with each job."""
        lifetime.stop.set()
        if lifetime.thread:
            # Short wait: an in-flight driver query is ignored once stopped, never awaited.
            lifetime.thread.join(timeout=1)
        receipt = {'contract': RESOURCE_CONTRACT,
            'child': {'spawnedAtMs': epoch_ms(lifetime.spawned), 'readyAtMs': epoch_ms(lifetime.ready),
                'releasedAtMs': epoch_ms(time.time()), 'reserveVramGiB': lifetime.reserve, 'jobIds': list(lifetime.job_ids)},
            'ram': ram, 'vram': lifetime.vram(),
            'jobs': [{'jobId': job_id, 'executionMs': self.execution_ms(job_id)} for job_id in lifetime.job_ids]}
        for job_id in lifetime.job_ids:
            try:
                file = self.record_path(job_id)
                self.write_record(file, {**json.loads(file.read_text()), 'resources': receipt})
            except (OSError, ValueError):
                pass  # The /free answer still carries the receipt; release is never refused for it.
        return {'resources': receipt}

    def record_path(self, job_id):
        if str(uuid.UUID(job_id)) != job_id:
            raise ValueError('Exact UUID required')
        return self.state / f'execution-{job_id}.json'

    def history(self, job_id):
        file = self.record_path(job_id)
        record = json.loads(file.read_text()) if file.exists() else {}
        if record.get('terminal'):
            return {job_id: record['terminal']}
        if not self.running():
            return {}
        data = self.call(f'/history/{job_id}')
        item = data.get(job_id)
        if item and item.get('status', {}).get('status_str') in ['success', 'error']:
            # Keep execution proof and output locators, not the graph or prompt.
            terminal = {k: item[k] for k in ['status', 'outputs'] if k in item}
            self.write_record(file, {'jobId': job_id, 'terminal': terminal})
            return {job_id: terminal}
        return data

    def write_record(self, file, record):
        temporary = file.with_name(f'{file.name}.{uuid.uuid4()}.tmp')
        with open(temporary, 'w') as f:
            os.chmod(temporary, 0o600)
            json.dump(record, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, file)
        self.sync_directory()

    def discard_output(self, job_id, expected_hash):
        """Remove one verified terminal output; retain the original execution receipt."""
        if not re.fullmatch(r'[a-f0-9]{64}', expected_hash or ''):
            raise ValueError('Exact output hash required')
        with self.lock:
            record_file = self.record_path(job_id)
            record = json.loads(record_file.read_text())
            terminal = record.get('terminal', {})
            if terminal.get('status', {}).get('status_str') != 'success' or terminal.get('status', {}).get('completed') is not True:
                raise ValueError('Terminal successful output required')
            outputs = terminal.get('outputs', {}).get('save', {}).get('images', [])
            if len(outputs) != 1:
                raise ValueError('One exact output index required')
            output = outputs[0]
            if output.get('type') != 'output' or output.get('subfolder') != 'agentx' or not re.fullmatch(re.escape(job_id) + r'_\d+_\.png', output.get('filename', '')):
                raise ValueError('Output does not belong to this job')
            prior = record.get('outputRemoval')
            if prior and (prior.get('sha256') != expected_hash or prior.get('output') != output):
                raise ValueError('Original output removal identity changed')
            if prior and prior.get('removed') is True:
                return {k: v for k, v in prior.items() if k != 'output'}
            directory = self.root / 'output' / 'agentx'
            if any(p.is_symlink() for p in [self.root, self.root / 'output', directory]):
                raise ValueError('Output directory alias refused')
            target = directory / output['filename']
            if target.is_symlink():
                raise ValueError('Output file alias refused')
            if not prior or target.exists():
                descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    before = os.fstat(descriptor)
                    if not stat.S_ISREG(before.st_mode) or before.st_size > 8 * 1024 * 1024:
                        raise ValueError('Invalid temporary output')
                    with os.fdopen(descriptor, 'rb', closefd=False) as source:
                        digest = hashlib.file_digest(source, 'sha256').hexdigest()
                    after = target.lstat()
                    if digest != expected_hash or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                        raise ValueError('Original output changed')
                finally:
                    os.close(descriptor)
                if not prior:
                    prior = {'contract': 'agentx.image-output-removal/v1', 'jobId': job_id, 'sha256': expected_hash,
                        'outputIndex': 0, 'output': output, 'removed': False,
                        'fileIdentity': [before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns]}
                    self.write_record(record_file, {**record, 'outputRemoval': prior})
                elif prior.get('fileIdentity') != [before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns]:
                    raise ValueError('Original output file identity changed')
            target.unlink(missing_ok=True)
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            receipt = {**prior, 'removed': True}
            self.write_record(record_file, {**record, 'outputRemoval': receipt})
            return {k: v for k, v in receipt.items() if k != 'output'}

    def submit(self, data):
        job_id = data['prompt_id']
        with self.lock:
            file = self.record_path(job_id)
            # Even a dispatch whose response was lost cannot execute twice.
            with open(file, 'x') as f:
                os.chmod(file, 0o600)
                json.dump({'jobId': job_id, 'dispatchStarted': True}, f)
                f.flush()
                os.fsync(f.fileno())
            self.sync_directory()
            reserve = self.reserve_for_graph(data['prompt'])
            if self.running() and reserve != self.current_reserve:
                self.free()
            self.start(reserve)
            queue = self.call('/queue')
            if queue.get('queue_running') or queue.get('queue_pending'):
                raise RuntimeError('CUDA worker is occupied')
            if self.lifetime:
                # Listed before dispatch: an uncertain prompt still shares this child's figures.
                self.lifetime.job_ids.append(job_id)
            return self.call('/prompt', data, timeout=90)

    def reserve_for_graph(self, graph):
        pixels = 0
        for node in graph.values():
            inputs = node.get('inputs', {})
            width, height, resolution = (inputs.get(k) for k in ['width', 'height', 'resolution'])
            if isinstance(width, int) and isinstance(height, int):
                pixels = max(pixels, width * height)
            if isinstance(resolution, int):
                pixels = max(pixels, resolution * resolution)
        # Large INT8 activations need room beyond the model-loading estimate.
        # Staging weights in RAM preserves precision and trades transfer time.
        return max(self.args.reserve_vram, 4.5) if pixels > 2359296 else self.args.reserve_vram

    def sync_directory(self):
        descriptor = os.open(self.state, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def free(self):
        with self.lock:
            lifetime = self.lifetime
            if not self.running():
                self.lifetime = None
                return self.resources(lifetime, {'method': 'linux-proc-vmhwm', 'scope': 'cuda-child-process',
                    'status': 'unavailable', 'reason': 'CUDA child exited before release'}) if lifetime else {}
            queue = self.call('/queue')
            if queue.get('queue_running') or queue.get('queue_pending'):
                raise RuntimeError('CUDA worker has unfinished work')
            for file in self.state.glob('execution-*.json'):
                self.history(file.stem.removeprefix('execution-'))
            # The high-water mark must be read while this exact child still exists.
            ram = self.process_ram_peak(self.child.pid) if lifetime else None
            if lifetime:
                lifetime.stop.set()
            self.child.terminate()
            try:
                self.child.wait(timeout=40)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=5)
            # wait() proves this exact child released its CUDA context.
            self.child = None
            self.lifetime = None
            return self.resources(lifetime, ram) if lifetime else {}

    def stats(self):
        raw = subprocess.check_output(['nvidia-smi', '-i', str(self.args.gpu),
            '--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], text=True, timeout=5)
        name, total, free = [x.strip() for x in raw.strip().split(',')]
        return {'devices': [{'name': name, 'index': self.args.gpu, 'type': 'cuda',
            'vram_total': int(total) * 1048576, 'vram_free': int(free) * 1048576,
            'torch_vram_total': 0, 'torch_vram_free': 0}], 'system': {'supervised': True},
            'outputRemoval': {'contract': 'agentx.image-output-removal/v1'}}

    def object_info(self):
        # The pinned schema is captured during setup; model presence stays live.
        for node, field, directory in [('UNETLoader', 'unet_name', 'diffusion_models'),
                ('CLIPLoader', 'clip_name', 'text_encoders'), ('VAELoader', 'vae_name', 'vae')]:
            self.nodes[node]['input']['required'][field][0] = sorted(
                p.name for p in (self.root / 'models' / directory).glob('*.safetensors'))
        return self.nodes


def create_handler(worker, allowed=frozenset()):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send(self, data, status=200, content_type='application/json'):
            raw = data if isinstance(data, bytes) else json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(raw)

        def handle_request(self):
            # On a LAN address the bind alone no longer limits callers to Core.
            if allowed and self.client_address[0] not in allowed:
                return self.send({'error': 'Caller is not an allowed client'}, 403)
            route = urlsplit(self.path)
            if self.command == 'GET':
                if route.path == '/system_stats':
                    stats = worker.call(route.path) if worker.running() else worker.stats()
                    self.send({**stats, 'outputRemoval': {'contract': 'agentx.image-output-removal/v1'}})
                elif route.path == '/object_info':
                    self.send(worker.object_info())
                elif route.path == '/queue':
                    self.send(worker.call(route.path) if worker.running() else {'queue_running': [], 'queue_pending': []})
                elif route.path.startswith('/history/'):
                    self.send(worker.history(route.path.removeprefix('/history/')))
                elif route.path == '/view':
                    query = parse_qs(route.query)
                    name = query.get('filename', [''])[0]
                    if query.get('type') != ['output'] or query.get('subfolder') != ['agentx'] or not re.fullmatch(r'[a-zA-Z0-9_.-]+\.png', name):
                        raise ValueError('Invalid image locator')
                    file = worker.root / 'output' / 'agentx' / name
                    if file.stat().st_size > 50 * 1024 * 1024:
                        raise ValueError('Image too large')
                    self.send(file.read_bytes(), content_type='image/png')
                else:
                    self.send({'error': 'Unknown endpoint'}, 404)
                return
            size = int(self.headers.get('Content-Length', '0'))
            if size < 0 or size > 10 * 1024 * 1024:
                raise ValueError('Request too large')
            body = self.rfile.read(size)
            if route.path == '/upload/image':
                message = email.parser.BytesParser(policy=email.policy.default).parsebytes(
                    f'Content-Type: {self.headers.get("Content-Type")}\r\nMIME-Version: 1.0\r\n\r\n'.encode() + body)
                part = next(p for p in message.iter_parts() if p.get_param('name', header='Content-Disposition') == 'image')
                name = part.get_filename()
                if not re.fullmatch(r'agentx-[a-f0-9-]{36}-[01]\.png', name or ''):
                    raise ValueError('Invalid reference filename')
                target = worker.root / 'input' / name
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(part.get_payload(decode=True))
                self.send({'name': name, 'subfolder': '', 'type': 'input'})
            elif route.path == '/prompt':
                self.send(worker.submit(json.loads(body)))
            elif route.path == '/free':
                self.send(worker.free())
            elif re.fullmatch(r'/api/jobs/[a-f0-9-]{36}/cancel', route.path):
                self.send(worker.call(route.path, json.loads(body)))
            elif re.fullmatch(r'/api/jobs/[a-f0-9-]{36}/discard-output', route.path):
                self.send(worker.discard_output(route.path.split('/')[3], json.loads(body).get('sha256')))
            else:
                self.send({'error': 'Unknown endpoint'}, 404)

        def dispatch(self):
            try:
                self.handle_request()
            except urllib.error.HTTPError as error:
                self.send(error.read(), error.code)
            except FileExistsError:
                self.send({'error': 'Execution identity already recorded; observe the original job'}, 409)
            except (ValueError, StopIteration, KeyError) as error:
                self.send({'error': str(error)}, 400)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                self.send({'error': str(error)}, 503)
        do_GET = dispatch
        do_POST = dispatch
    return Handler


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--state', required=True)
    parser.add_argument('--object-info', required=True)
    parser.add_argument('--python', required=True)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8188)
    parser.add_argument('--child-port', type=int, default=8189)
    parser.add_argument('--gpu', type=int, default=0)
    parser.add_argument('--reserve-vram', type=float, default=1.2)
    parser.add_argument('--vram-sample-ms', type=int, default=1000,
        help="Interval for sampling the CUDA child's own device memory; 0 disables it. Samples give a lower bound, never a peak.")
    parser.add_argument('--allow-client', action='append', default=[],
        help='Source address allowed to call the worker; repeat for several. Without it, every caller that reaches the bind address is accepted.')
    args = parser.parse_args()
    address = ipaddress.ip_address(args.bind)
    if not address.is_private or address.is_unspecified:
        parser.error('The worker must bind an explicit private or loopback address')
    if args.vram_sample_ms != 0 and not 200 <= args.vram_sample_ms <= 60000:
        parser.error('--vram-sample-ms must be 0 or between 200 and 60000')
    server = ThreadingHTTPServer((args.bind, args.port), create_handler(Worker(args), {str(ipaddress.ip_address(x)) for x in args.allow_client}))
    server.serve_forever()
