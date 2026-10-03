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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs


class Worker:
    def __init__(self, args):
        self.args = args
        self.root = pathlib.Path(args.root).resolve()
        self.state = pathlib.Path(args.state).resolve()
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.nodes = json.loads(pathlib.Path(args.object_info).read_text())
        self.child = None
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

    def start(self):
        if self.running():
            return
        env = {**os.environ, 'CUDA_VISIBLE_DEVICES': str(self.args.gpu),
            'PYTHONDONTWRITEBYTECODE': '1'}
        self.child = subprocess.Popen([self.args.python, '-u', 'main.py',
            '--listen', '127.0.0.1', '--port', str(self.args.child_port),
            '--disable-auto-launch', '--disable-api-nodes', '--disable-metadata',
            '--disable-all-custom-nodes', '--disable-dynamic-vram', '--cache-none',
            '--reserve-vram', str(self.args.reserve_vram)], cwd=self.root, env=env,
            stdout=self.log, stderr=self.log, start_new_session=True)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if not self.running():
                raise RuntimeError('CUDA worker failed to start')
            try:
                self.call('/system_stats', timeout=2)
                return
            except (OSError, urllib.error.URLError):
                time.sleep(.25)
        raise RuntimeError('CUDA worker startup is unverified')

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
            temporary = file.with_name(f'{file.name}.{uuid.uuid4()}.tmp')
            with open(temporary, 'w') as f:
                os.chmod(temporary, 0o600)
                json.dump({'jobId': job_id, 'terminal': terminal}, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temporary, file)
            self.sync_directory()
            return {job_id: terminal}
        return data

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
            self.start()
            queue = self.call('/queue')
            if queue.get('queue_running') or queue.get('queue_pending'):
                raise RuntimeError('CUDA worker is occupied')
            return self.call('/prompt', data, timeout=90)

    def sync_directory(self):
        descriptor = os.open(self.state, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def free(self):
        with self.lock:
            if not self.running():
                return {}
            queue = self.call('/queue')
            if queue.get('queue_running') or queue.get('queue_pending'):
                raise RuntimeError('CUDA worker has unfinished work')
            for file in self.state.glob('execution-*.json'):
                self.history(file.stem.removeprefix('execution-'))
            self.child.terminate()
            try:
                self.child.wait(timeout=40)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=5)
            # wait() proves this exact child released its CUDA context.
            self.child = None
            return {}

    def stats(self):
        raw = subprocess.check_output(['nvidia-smi', '-i', str(self.args.gpu),
            '--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], text=True, timeout=5)
        name, total, free = [x.strip() for x in raw.strip().split(',')]
        return {'devices': [{'name': name, 'index': self.args.gpu, 'type': 'cuda',
            'vram_total': int(total) * 1048576, 'vram_free': int(free) * 1048576,
            'torch_vram_total': 0, 'torch_vram_free': 0}], 'system': {'supervised': True}}

    def object_info(self):
        # The pinned schema is captured during setup; model presence stays live.
        for node, field, directory in [('UNETLoader', 'unet_name', 'diffusion_models'),
                ('CLIPLoader', 'clip_name', 'text_encoders'), ('VAELoader', 'vae_name', 'vae')]:
            self.nodes[node]['input']['required'][field][0] = sorted(
                p.name for p in (self.root / 'models' / directory).glob('*.safetensors'))
        return self.nodes


def create_handler(worker):
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
            route = urlsplit(self.path)
            if self.command == 'GET':
                if route.path == '/system_stats':
                    self.send(worker.call(route.path) if worker.running() else worker.stats())
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
    args = parser.parse_args()
    address = ipaddress.ip_address(args.bind)
    if not address.is_private or address.is_unspecified:
        parser.error('The worker must bind an explicit private or loopback address')
    server = ThreadingHTTPServer((args.bind, args.port), create_handler(Worker(args)))
    server.serve_forever()
