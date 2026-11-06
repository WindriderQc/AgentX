"""Synthetic native collector tests. Never reads the local host or network."""
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('observe', pathlib.Path(__file__).with_name('observe.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ObserverTests(unittest.TestCase):
    def test_targets_are_typed_and_http_is_private_without_credentials_or_redirects(self):
        for url in ['https://example.com/', 'http://8.8.8.8/', 'http://user:pass@127.0.0.1/',
                    'http://127.0.0.1/a?token=x', 'http://127.0.0.1/a\nheader', 'file:///tmp/test']:
            with self.assertRaises(ValueError):
                m.local_url(url)
        self.assertEqual(m.local_url('http://192.168.10.4:8188/system_stats'), 'http://192.168.10.4:8188/system_stats')
        self.assertIsNone(m.NoRedirect().redirect_request(None, None, 302, '', {}, 'http://public.invalid'))
        for target in ['--all', 'a;rm', 'a.service\nb.service', '*']:
            with self.assertRaises(ValueError):
                m.validate({'version': 1, 'checks': [{'id': 'test', 'kind': 'docker', 'targets': [target]}]})

    def test_docker_partial_state_is_not_task_acceptance_or_secret_inspection(self):
        checks = [{'id': 'service', 'kind': 'docker', 'targets': ['synthetic-a', 'synthetic-b']}]
        def command(args):
            self.assertEqual(args[1:4], ['inspect', '--format', '{{.Name}} {{json .State}}'])
            return '/synthetic-a {"Running":true,"Health":{"Status":"healthy"}}\n/synthetic-b {"Running":true,"Health":{"Status":"unhealthy"}}'
        with patch.object(m, 'command', command):
            result = m.process_checks(checks, 'docker')
        self.assertEqual(result[0]['state'], 'degraded')
        self.assertNotIn('synthetic-a', str(result))
        with patch.object(m, 'command', return_value='/synthetic-a {"Running":true}'):
            result = m.process_checks(checks, 'docker')
        self.assertEqual(result[0]['state'], 'unknown')
        self.assertIsNone(result[0]['observedAt'])

    def test_prometheus_preserves_scrape_time_not_evaluation_time(self):
        checks = [{'id': 'host', 'kind': 'prometheus', 'metric': 'up', 'labels': {'host': 'fixture'}, 'source': 'host_collector'}]
        def vector(query):
            return [{'metric': {'host': 'fixture'}, 'value': [2000000000, '1900000000' if query.startswith('timestamp(') else '0']}]
        with patch.object(m, 'prom_vector', vector):
            row = m.prometheus_checks(checks)[0]
        self.assertEqual(row['observedAt'], m.stamp(1900000000))
        self.assertEqual(row['state'], 'offline')
        self.assertEqual(row['source'], 'host_collector')
        with patch.object(m, 'prom_vector', return_value=[]):
            self.assertIsNone(m.prometheus_checks(checks)[0]['observedAt'])

    def test_systemd_active_exited_is_not_a_running_agent(self):
        checks = [{'id': 'agent', 'kind': 'systemd', 'scope': 'user', 'targets': ['fixture.service']}]
        with patch.object(m, 'command', return_value='Id=fixture.service\nLoadState=loaded\nActiveState=active\nSubState=exited'):
            self.assertEqual(m.process_checks(checks, 'systemd', 'user')[0]['state'], 'offline')
        with patch.object(m, 'command', return_value='Id=fixture.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead'):
            self.assertEqual(m.process_checks(checks, 'systemd', 'user')[0]['state'], 'unknown')

    def test_interface_checks_only_reachability_and_does_not_read_stream_body(self):
        for code, state in [(200, 'online'), (302, 'online'), (401, 'online'), (403, 'online'), (404, 'offline'), (503, 'offline')]:
            with patch.object(m, 'http_status', return_value=code):
                self.assertEqual(m.interface_check({'id': 'interface', 'url': 'http://127.0.0.1/'})[0]['state'], state)


if __name__ == '__main__':
    unittest.main()
