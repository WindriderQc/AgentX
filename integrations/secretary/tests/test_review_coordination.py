"""Core owns physical overlap; scoped clients do not clear unrelated holders."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mail_catchup import CoreClient

QUEUE = '11111111-1111-4111-8111-111111111111'
DISPATCH = '22222222-2222-4222-8222-222222222222'


class ScopedCoordinationTests(unittest.TestCase):
    def client(self, release, active=None):
        seen = []
        def open_(request, **_):
            seen.append(request.full_url)
            value = release if '/operator-release?' in request.full_url else active or {}
            response = MagicMock(status=200, headers={})
            response.read.return_value = json.dumps({'data': value}).encode()
            response.__enter__.return_value = response
            return response
        return CoreClient('http://core.invalid', opener=open_, queue_scope=(QUEUE, DISPATCH)), seen

    def release(self, **changed):
        return {'contract': 'agentx.operator-release/v1', 'authority': 'core.runtime-coordination',
                'queueRequestId': QUEUE, 'dispatchId': DISPATCH, 'runtimeReleased': True, **changed}

    def test_unrelated_work_does_not_block_a_core_verified_resource_scope(self):
        other = {'workloads': [{'kind': 'judge', 'hosts': ['http://other.invalid:11434']}],
                 'inferences': [{'host': 'http://other.invalid:11434', 'quarantined': True}]}
        client, seen = self.client(self.release(), other)
        self.assertIsNone(client.busy());self.assertTrue(other['inferences'][0]['quarantined'])
        self.assertEqual(seen[-1], 'http://core.invalid/api/cluster/schedule/work-queue/' + QUEUE + '/operator-release?dispatchId=' + DISPATCH)

    def test_native_overlap_even_without_coarse_workloads_keeps_the_client_paused(self):
        client, _ = self.client(self.release(runtimeReleased=False))
        self.assertEqual(client.busy(), 'native resources held for this dispatch')

    def test_missing_or_wrong_scope_evidence_fails_closed(self):
        for change in ({'contract': 'wrong'}, {'authority': 'wrong'}, {'queueRequestId': DISPATCH},
                       {'dispatchId': QUEUE}, {'runtimeReleased': 'true'}, {'runtimeReleased': None}):
            with self.subTest(change=change):
                client, _ = self.client(self.release(**change))
                self.assertEqual(client.busy(), 'scoped runtime evidence unavailable')
        client, _ = self.client({});self.assertEqual(client.busy(), 'scoped runtime evidence unavailable')

    def test_maintenance_and_announced_recreate_still_precede_any_scope_lookup(self):
        for field, reason in (('maintenance', 'maintenance'), ('drain', 'deploy pending')):
            client, seen = self.client(self.release(), {field: {'held': True}})
            self.assertEqual(client.busy(), reason);self.assertEqual(len(seen), 1)

    def test_invalid_scope_cannot_be_used_to_query_another_resource(self):
        for scope in (('', DISPATCH), ('bad/path', DISPATCH), (QUEUE,), [QUEUE, DISPATCH]):
            with self.subTest(scope=scope), self.assertRaises(ValueError):CoreClient('http://core.invalid', queue_scope=scope)


if __name__ == '__main__':unittest.main()
