"""Bounded JSON-RPC client for Codex's local Unix WebSocket control socket."""
import base64
import hashlib
import json
import os
import socket
import struct
import time


class Client:
    def __init__(self, socket_path, timeout=15):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(timeout)
        self.buffer = b''
        self.counter = 0
        self.timeout = timeout
        try:
            self.socket.connect(os.path.realpath(socket_path))
            key = base64.b64encode(os.urandom(16)).decode()
            self.socket.sendall((
                'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
                'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\n'
                'Sec-WebSocket-Version: 13\r\n\r\n'
            ).encode())
            while b'\r\n\r\n' not in self.buffer:
                chunk = self.socket.recv(4096)
                if not chunk:
                    raise RuntimeError('Codex handshake closed')
                self.buffer += chunk
                if len(self.buffer) > 16384:
                    raise RuntimeError('Codex handshake too large')
            headers, self.buffer = self.buffer.split(b'\r\n\r\n', 1)
            accept = base64.b64encode(hashlib.sha1((
                key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
            ).encode()).digest())
            if not headers.startswith(b'HTTP/1.1 101 ') or accept.lower() not in headers.lower():
                raise RuntimeError('Codex WebSocket handshake refused')
            self.rpc('initialize', {
                'clientInfo': {'name': 'agentx-catalog-watch', 'version': '1.0.0'},
                'capabilities': {'experimentalApi': True},
            })
            self.send({'method': 'initialized', 'params': {}})
        except Exception:
            self.socket.close()
            raise

    def take(self, size):
        while len(self.buffer) < size:
            chunk = self.socket.recv(max(4096, size - len(self.buffer)))
            if not chunk:
                raise RuntimeError('Codex WebSocket closed')
            self.buffer += chunk
        result, self.buffer = self.buffer[:size], self.buffer[size:]
        return result

    def send(self, value, opcode=1):
        data = json.dumps(value).encode() if opcode == 1 else value
        mask, size = os.urandom(4), len(data)
        if size < 126:
            header = bytes([128 | opcode, 128 | size])
        elif size < 65536:
            header = bytes([128 | opcode, 128 | 126]) + struct.pack('!H', size)
        else:
            header = bytes([128 | opcode, 128 | 127]) + struct.pack('!Q', size)
        self.socket.sendall(header + mask + bytes(v ^ mask[i % 4] for i, v in enumerate(data)))

    def receive(self):
        data = b''
        while True:
            first, second = self.take(2)
            size = second & 127
            if size == 126:
                size = struct.unpack('!H', self.take(2))[0]
            elif size == 127:
                size = struct.unpack('!Q', self.take(8))[0]
            if size + len(data) > 8000000:
                raise RuntimeError('Codex WebSocket message too large')
            mask = self.take(4) if second & 128 else None
            payload = self.take(size)
            if mask:
                payload = bytes(v ^ mask[i % 4] for i, v in enumerate(payload))
            opcode = first & 15
            if opcode == 8:
                raise RuntimeError('Codex WebSocket closed by server')
            if opcode == 9:
                self.send(payload, 10)
                continue
            if opcode == 10:
                continue
            if opcode not in (0, 1):
                raise RuntimeError('Unsupported Codex WebSocket message')
            data += payload
            if first & 128:
                return json.loads(data)

    def rpc(self, method, params):
        self.counter += 1
        request_id = self.counter
        self.send({'id': request_id, 'method': method, 'params': params})
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            self.socket.settimeout(max(0.001, deadline - time.monotonic()))
            response = self.receive()
            if response.get('id') == request_id:
                if 'error' in response:
                    # Error payloads may contain configuration values. Do not log them.
                    raise RuntimeError(f'Codex {method} refused ({response["error"].get("code")})')
                return response['result']
        raise TimeoutError(f'Codex {method} timed out')

    def close(self):
        try:
            self.send(b'', 8)
        finally:
            self.socket.close()
