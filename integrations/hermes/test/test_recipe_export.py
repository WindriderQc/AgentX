import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recipe_export import export_recipe

ID = '11111111-1111-4111-8111-111111111111'
ROUTE = '/api/images/operations/' + ID + '/export'


class Client:
    def __init__(self):
        self.files = {'graph.json': b'{"recorded":"graph"}', 'output.png': b'output bytes',
                      'reference-0-source.jpg': b'original metadata', 'reference-0-worker.png': b'worker copy'}
        self.manifest = {'schemaVersion': 1, 'operation': {'id': ID, 'state': 'completed', 'runtimeRestored': True},
                         'parts': [{'name': name, 'url': ROUTE + '/parts/' + name, 'size': len(raw),
                                    'sha256': hashlib.sha256(raw).hexdigest()} for name, raw in self.files.items()]}
        self.reads = []

    def read(self, path, **_):
        self.reads.append(path)
        return json.dumps(self.manifest).encode() if path == ROUTE else self.files[path.rsplit('/', 1)[-1]]


class ExportTests(unittest.TestCase):
    def test_exports_exact_recorded_bytes_and_refuses_existing_directory(self):
        client = Client()
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'recipe'
            result = export_recipe(client, ID, target)
            self.assertTrue(result['ok'])
            self.assertEqual(json.loads((target / 'image-recipe.json').read_bytes()), client.manifest)
            for name, raw in client.files.items():
                self.assertEqual((target / name).read_bytes(), raw)
            with self.assertRaises(FileExistsError):
                export_recipe(client, ID, target)

    def test_mismatch_in_last_part_publishes_nothing(self):
        client = Client()
        client.files['reference-0-worker.png'] = b'corrupted'
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'recipe'
            with self.assertRaises(ValueError):
                export_recipe(client, ID, target)
            self.assertFalse(target.exists())

    def test_bad_identity_restoration_path_url_and_duplicates_refuse_before_part_reads(self):
        for change in ['identity', 'restoration', 'path', 'url', 'duplicate', 'missing-output']:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as root:
                client = Client()
                if change == 'identity': client.manifest['operation']['id'] = 'another-operation'
                if change == 'restoration': client.manifest['operation']['runtimeRestored'] = False
                if change == 'path': client.manifest['parts'][0]['name'] = '../graph.json'
                if change == 'url': client.manifest['parts'][0]['url'] = 'http://other-worker/graph.json'
                if change == 'duplicate': client.manifest['parts'].append(dict(client.manifest['parts'][0]))
                if change == 'missing-output': client.manifest['parts'] = [p for p in client.manifest['parts'] if p['name'] != 'output.png']
                with self.assertRaises(ValueError):
                    export_recipe(client, ID, Path(root) / 'recipe')
                self.assertEqual(client.reads, [ROUTE])


if __name__ == '__main__':
    unittest.main()
