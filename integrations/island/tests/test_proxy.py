import contextlib
import http.client
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm_proxy import LLMProxy, MAX_BODY


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        calls = self.calls
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                calls.append((self.path, dict(self.headers), json.loads(body)))
                self.send_response(302 if calls[-1][2].get('redirect') else 200)
                self.send_header('Location', 'https://unreachable.invalid/private')
                self.send_header('Set-Cookie', 'private=upstream')
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(b'event: response.completed\ndata: {"fixture":true}\n\n')
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.proxy = LLMProxy(f'http://127.0.0.1:{self.server.server_port}/api/llm/v1', 'synthetic-upstream-secret')
        self.proxy.__enter__()

    def tearDown(self):
        self.proxy.__exit__(None, None, None)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def call(self, method, path, body=None, auth=True, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.proxy.port, timeout=3)
        values = {'Authorization': 'Bearer ' + self.proxy.capability} if auth else {}
        values.update(headers or {})
        conn.request(method, path, body=body, headers=values)
        response = conn.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        conn.close()
        return result

    def test_outside_routes_methods_encoding_queries_never_reach_core(self):
        for path in ['/health', '/api/cluster/schedule/work-queue', '/api/nerve-center/agent-runtime-config/export',
                     '/api/llm/v1/../health', '/api/llm/v1/%2e%2e/health', '//api/llm/v1/responses',
                     '/api/llm/v1/models?path=/health', 'http://unreachable.invalid/api/llm/v1/models']:
            with self.subTest(path=path): self.assertEqual(self.call('GET', path)[0], 403)
        for method in ['PUT', 'PATCH', 'DELETE', 'CONNECT', 'TRACE', 'OPTIONS', 'HEAD']:
            with self.subTest(method=method): self.assertEqual(self.call(method, '/api/llm/v1/models')[0], 403)
        self.assertEqual(self.calls, [])

    def test_ephemeral_auth_and_logical_models_only(self):
        self.assertEqual(self.call('GET', '/api/llm/v1/models', auth=False)[0], 401)
        self.assertEqual(self.call('GET', '/api/llm/v1/models', headers={'Authorization':'Bearer synthetic-upstream-secret'})[0], 401)
        status, _, body = self.call('GET', '/api/llm/v1/models')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['data'][0]['id'], 'agentx-primary')
        self.assertEqual(self.calls, [])

    def test_forwards_responses_once_streams_and_strips_credentials_and_redirect_headers(self):
        body = json.dumps({'model':'agentx-primary', 'input':'synthetic', 'stream':True})
        status, headers, data = self.call('POST', '/api/llm/v1/responses', body, headers={'X-Admin':'spoofed'})
        self.assertEqual(status, 200)
        self.assertIn(b'response.completed', data)
        self.assertNotIn('Set-Cookie', headers)
        self.assertNotIn('Location', headers)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][0], '/api/llm/v1/responses')
        self.assertEqual(self.calls[0][1]['Authorization'], 'Bearer synthetic-upstream-secret')
        self.assertNotIn('X-Admin', self.calls[0][1])
        self.assertNotIn(self.proxy.capability, str(self.calls))

    def test_rejects_invalid_bodies_models_chunking_and_duplicate_lengths(self):
        for body, expected in [('not json',400), ('[]',403), ('{"model":"other"}',403)]:
            self.assertEqual(self.call('POST', '/api/llm/v1/responses', body)[0], expected)
        self.assertEqual(self.call('POST', '/api/llm/v1/responses', '{}', headers={'Transfer-Encoding':'chunked'})[0], 400)
        conn = http.client.HTTPConnection('127.0.0.1', self.proxy.port, timeout=3)
        conn.putrequest('POST', '/api/llm/v1/responses')
        conn.putheader('Authorization', 'Bearer ' + self.proxy.capability)
        conn.putheader('Content-Length','2')
        conn.putheader('Content-Length','2')
        conn.endheaders(b'{}')
        self.assertEqual(conn.getresponse().status, 411)
        conn.close()
        self.assertEqual(self.calls, [])

    def test_image_sized_history_within_core_budget_reaches_upstream_once(self):
        body = json.dumps({'model': 'agentx-primary', 'input': 'synthetic-image-history-' + 'x' * (9 * 1024 * 1024)})
        status, _, _ = self.call('POST', '/api/llm/v1/responses', body)
        self.assertEqual(status, 200)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][2]['input'], json.loads(body)['input'])

    def test_oversized_declared_body_refuses_before_reading_or_dispatching(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.proxy.port, timeout=3)
        conn.request('POST', '/api/llm/v1/responses', headers={
            'Authorization': 'Bearer ' + self.proxy.capability, 'Content-Length': str(MAX_BODY + 1)})
        self.assertEqual(conn.getresponse().status, 413)
        conn.close()
        self.assertEqual(self.calls, [])

    def test_redirect_is_not_followed_and_no_upstream_in_netcheck(self):
        status, _, _ = self.call('POST','/api/llm/v1/responses', json.dumps({'model':'agentx-primary','redirect':True}))
        self.assertEqual(status,502)
        self.assertEqual(len(self.calls),1)
        with LLMProxy(None) as dry:
            conn = http.client.HTTPConnection('127.0.0.1', dry.port, timeout=3)
            conn.request('POST','/api/llm/v1/responses','{"model":"agentx-primary"}', {'Authorization':'Bearer '+dry.capability})
            self.assertEqual(conn.getresponse().status,503)
            conn.close()
        self.assertEqual(len(self.calls),1)

    def test_invalid_upstream_and_unsafe_credential_transport_refused(self):
        for value in ['http://remote.invalid/api/llm/v1', 'https://host.invalid/', 'https://user:pass@host.invalid/api/llm/v1',
                      'https://host.invalid/api/llm/v1?redirect=1']:
            with self.subTest(value=value), self.assertRaises(ValueError): LLMProxy(value,'synthetic')

    @unittest.skipUnless(__import__('shutil').which('bwrap'), 'bubblewrap not installed')
    def test_real_network_namespace_can_only_use_restricted_unix_relay(self):
        import socketserver
        import socket
        import subprocess
        import tempfile
        test = self
        class Relay(socketserver.BaseRequestHandler):
            def handle(self):
                data=b''
                while b'\r\n\r\n' not in data:
                    chunk=self.request.recv(4096)
                    if not chunk:return
                    data+=chunk
                with socket.create_connection(('127.0.0.1',test.proxy.port), timeout=3) as upstream:
                    upstream.sendall(data)
                    while chunk:=upstream.recv(65536):
                        try: self.request.sendall(chunk)
                        except OSError: return  # The guest intentionally closes after the response header.
        with tempfile.TemporaryDirectory(prefix='cb-relay-') as temp:
            server=socketserver.ThreadingUnixStreamServer(str(Path(temp)/'proxy.sock'),Relay)
            worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
            guest='''import socket,json,sys
results=[]
for path in ['/health','/api/cluster/schedule/work-queue','/api/nerve-center/agent-runtime-config/export','/api/llm/v1/models']:
 s=socket.socket(socket.AF_UNIX);s.connect('/relay/proxy.sock')
 s.sendall(('GET '+path+' HTTP/1.0\\r\\nHost: gateway\\r\\nAuthorization: Bearer '+sys.argv[1]+'\\r\\n\\r\\n').encode())
 data=s.recv(4096);results.append(int(data.split()[1]));s.close()
s=socket.socket();s.settimeout(.2)
try:s.connect(('127.0.0.1',int(sys.argv[2])));direct=True
except OSError:direct=False
print(json.dumps({'codes':results,'direct':direct}))
'''
            args=['bwrap','--unshare-net','--unshare-pid','--unshare-ipc']
            for root in ['/usr','/bin','/lib','/lib64']:
                if Path(root).exists(): args+=['--ro-bind',root,root]
            args+=['--proc','/proc','--dev','/dev','--tmpfs','/run','--ro-bind',temp,'/relay','--',
                   '/usr/bin/python3','-c',guest,self.proxy.capability,str(self.server.server_port)]
            try:
                result=subprocess.run(args,capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(json.loads(result.stdout),{'codes':[403,403,403,200],'direct':False})
                self.assertEqual(self.calls,[])
            finally:
                server.shutdown();server.server_close();worker.join()
