import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import worker


def fixture():
    references = [{'kind': 'upload', 'attachmentId': '1' * 24, 'sha256': 'a' * 64, 'position': 0,
                   'mimeType': 'image/png', 'byteLength': 123, 'width': 32, 'height': 32}]
    digest = hashlib.sha256(json.dumps(references, separators=(',', ':')).encode()).hexdigest()
    return {'action': 'plan', 'request': {'prompt': 'Full brief ending SENTINEL', 'inspectReferences': True, 'references': references},
            'referenceInspection': {'version': 1, 'source': 'openclaw-main', 'referenceSha256': digest,
                                    'references': references, 'analysis': 'A blue square; text uncertain.',
                                    'nativeReceipt': {'source': 'openclaw', 'mode': 'agent',
                                                      'requestId': '11111111-1111-4111-8111-111111111111',
                                                      'runId': 'native-fixture', 'completion': 'completed', 'requested': {'agentId': 'main'}}}}


class InspectionTests(unittest.TestCase):
    def test_verified_analysis_is_attributed_without_claiming_hermes_saw_pixels(self):
        payload = fixture()
        query = worker.query(payload)
        self.assertIn('Pixels are not supplied to Hermes', query)
        self.assertIn('advisory analysis by OpenClaw Main', query)
        self.assertIn('Do not invoke another vision', query)
        self.assertIn(payload['referenceInspection']['analysis'], query)
        self.assertIn(payload['request']['prompt'], query)
        self.assertNotIn('Reference images are NOT supplied to you', query)
        plain = worker.query({'action': 'consult', 'prompt': 'Text only'})
        self.assertIn('Reference images are NOT supplied to you', plain)

    def test_unverified_oversized_or_raw_evidence_refuses_before_reasoning(self):
        invalid = []
        payload = fixture(); del payload['referenceInspection']; invalid.append(payload)
        payload = fixture(); payload['referenceInspection']['analysis'] = 'x' * 16001; invalid.append(payload)
        payload = fixture(); payload['referenceInspection']['nativeReceipt']['requested']['agentId'] = 'other'; invalid.append(payload)
        payload = fixture(); payload['referenceInspection']['nativeReceipt']['completion'] = 'unknown'; invalid.append(payload)
        payload = fixture(); payload['referenceInspection']['references'][0]['base64'] = 'raw'; invalid.append(payload)
        payload = fixture(); payload['referenceInspection']['references'][0]['path'] = '/private/path'; invalid.append(payload)
        payload = fixture(); payload['request']['references'] = []; invalid.append(payload)
        for payload in invalid:
            with self.assertRaises(ValueError):
                worker.query(copy.deepcopy(payload))
