import json
import struct
import unittest

from app_server_rpc import Client


def frame(payload, opcode=1, final=True):
    data = json.dumps(payload).encode() if opcode == 1 else payload
    first = (128 if final else 0) | opcode
    if len(data) < 126:
        return bytes([first, len(data)]) + data
    return bytes([first, 126]) + struct.pack('!H', len(data)) + data


class Socket:
    def __init__(self):
        self.sent = []

    def sendall(self, data):
        self.sent.append(data)

    def settimeout(self, _):
        pass


class RpcTests(unittest.TestCase):
    def client(self, payload):
        client = Client.__new__(Client)
        client.socket = Socket()
        client.buffer = payload
        client.counter = 0
        client.timeout = 1
        return client

    def test_notifications_do_not_replace_matching_rpc_response(self):
        client = self.client(frame({'method': 'unrelated/notification'}) + frame({'id': 1, 'result': {}}))
        self.assertEqual(client.rpc('config/read', {}), {})

    def test_fragmented_text_and_ping_keep_transport_order(self):
        payload = b'{"id":1,"result":{}}'
        client = self.client(bytes([1, 10]) + payload[:10] + frame(b'ping', 9)
                             + frame(payload[10:], 0))
        self.assertEqual(client.receive(), {'id': 1, 'result': {}})
        self.assertEqual(client.socket.sent[0][0] & 15, 10)

    def test_error_payload_is_not_exposed_to_logs(self):
        client = self.client(frame({'id': 1, 'error': {'code': -32602, 'message': 'private value'}}))
        with self.assertRaisesRegex(RuntimeError, '-32602') as caught:
            client.rpc('config/batchWrite', {})
        self.assertNotIn('private value', str(caught.exception))

    def test_large_frames_are_bounded_and_client_frames_are_masked(self):
        client = self.client(bytes([129, 127]) + struct.pack('!Q', 8000001))
        with self.assertRaisesRegex(RuntimeError, 'too large'):
            client.receive()
        client.send({'test': 'x' * 70000})
        encoded = client.socket.sent[0]
        self.assertEqual(encoded[1], 255)
        size = struct.unpack('!Q', encoded[2:10])[0]
        mask = encoded[10:14]
        decoded = bytes(value ^ mask[i % 4] for i, value in enumerate(encoded[14:]))
        self.assertEqual(len(decoded), size)
        self.assertEqual(json.loads(decoded)['test'], 'x' * 70000)


if __name__ == '__main__':
    unittest.main()
