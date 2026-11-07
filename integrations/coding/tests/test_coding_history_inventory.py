import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('history_inventory', Path(__file__).resolve().parents[1] / 'coding_history_inventory.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class HistoryInventoryTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.parent = Path(directory.name).resolve()
        self.source = self.parent / 'source'
        self.source.mkdir()
        (self.source / 'sessions').mkdir()
        (self.source / 'sessions/session.v4.jsonl').write_text('synthetic native bytes\n')
        (self.source / 'empty').mkdir()

    def test_preserves_every_generation_attachment_and_continuation_receipt(self):
        for name in ('sessions/session.jsonl.zstd', 'attachments/photo.bin', 'handoffs/receipt.json'):
            path = self.source / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(b'synthetic\x00private')
        value = module.inventory(self.source)
        self.assertEqual(len(value['entries']), 4)
        self.assertIn('empty', value['directories'])
        self.assertTrue(module.compare(value, self.source)['matches'])
        self.assertNotIn('synthetic native bytes', json.dumps(value))

    def test_rejects_same_size_changed_content_and_added_or_missing_files(self):
        value = module.inventory(self.source)
        path = self.source / 'sessions/session.v4.jsonl'
        path.write_text(path.read_text().replace('native', 'edited'))
        self.assertEqual(module.compare(value, self.source)['changed'], ['sessions/session.v4.jsonl'])
        path.unlink()
        (self.source / 'extra').write_text('new')
        result = module.compare(value, self.source)
        self.assertEqual(result['missing'], ['sessions/session.v4.jsonl'])
        self.assertEqual(result['added'], ['extra'])

    def test_never_follows_external_links_or_root_links(self):
        target = self.parent / 'outside'
        target.write_text('must not be read')
        (self.source / 'link').symlink_to(target)
        value = module.inventory(self.source)
        self.assertEqual(value['entries']['link'], {'kind': 'symlink', 'target': str(target)})
        link = self.parent / 'root-link'
        link.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError):
            module.inventory(link)

    def test_backup_comparison_checks_empty_directories_and_exclusions(self):
        (self.source / 'node_modules').mkdir()
        (self.source / 'node_modules/cache').write_text('dependency')
        value = module.inventory(self.source)
        self.assertEqual(value['excludedNames'], ['node_modules'])
        (self.source / 'empty').rmdir()
        self.assertFalse(module.compare(value, self.source)['matches'])
        value['excludedNames'] = ['../sessions']
        with self.assertRaises(ValueError):
            module.compare(value, self.source)

    def test_receipt_cannot_overwrite_or_modify_source(self):
        value = module.inventory(self.source)
        with self.assertRaises(ValueError):
            module.write_private(self.source / 'manifest.json', value, [self.source])
        output = self.parent / 'manifest.json'
        module.write_private(output, value, [self.source])
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            module.write_private(output, value, [self.source])

    def test_refuses_special_files(self):
        os.mkfifo(self.source / 'pipe')
        with self.assertRaises(ValueError):
            module.inventory(self.source)


if __name__ == '__main__':
    unittest.main()
