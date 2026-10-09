import hashlib
import importlib.util
import io
import tempfile
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
spec = importlib.util.spec_from_file_location('imagex_images', Path(__file__).resolve().parents[1] / 'images.py')
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)
ID = '11111111-1111-4111-8111-111111111111'


class ImageTests(unittest.TestCase):
    def test_requires_an_explicit_local_core_origin(self):
        for url in ['https://example.com', 'http://127.0.0.1:3180/?secret=1', 'http://user:password@127.0.0.1:3180', 'http://127.0.0.1:3180/path']:
            with self.assertRaises(ValueError):
                images.Images(url)
        images.Images('http://127.0.0.1:3180')

    def test_download_requires_restoration_and_exact_archive_integrity(self):
        client = images.Images('http://127.0.0.1:3180')
        body = b'fixture bytes'
        operation = {'state': 'completed', 'runtimeRestored': False,
                     'artifact': {'url': f'/api/images/operations/{ID}/image', 'sha256': hashlib.sha256(body).hexdigest()}}
        client.json = lambda _: {'operation': operation}
        reads = []
        client.read = lambda path, **_: reads.append(path) or body
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / 'image.png'
            with self.assertRaises(ValueError):
                client.download(ID, output)
            self.assertEqual(reads, [])
            operation['runtimeRestored'] = True
            operation['artifact']['sha256'] = '0' * 64
            with self.assertRaises(ValueError):
                client.download(ID, output)
            self.assertFalse(output.exists())
            operation['artifact']['sha256'] = hashlib.sha256(body).hexdigest()
            self.assertTrue(client.download(ID, output)['ok'])
            self.assertEqual(output.read_bytes(), body)
            with self.assertRaises(FileExistsError):
                client.download(ID, output)


if __name__ == '__main__':
    unittest.main()
