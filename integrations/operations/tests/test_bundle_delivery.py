from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bundle_delivery


class BundleDeliveryTests(unittest.TestCase):
    def test_verified_delivery_is_non_destructive_and_preserves_unchanged_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staging = root / 'staging'
            current = staging / 'current'
            current.mkdir(parents=True)
            (current / 'published.txt').write_text('New revision')
            destination = root / 'destination'
            destination.mkdir()
            (destination / 'local.txt').write_text('Keep this local file')
            with patch.object(bundle_delivery.archive_mirror, 'Remote'), patch.object(bundle_delivery.archive_mirror, 'mirror', return_value={'status': 'verified'}):
                result = bundle_delivery.deliver('operator@source', '/published', staging, destination)
                self.assertEqual(result['files'], 1)
                self.assertEqual((destination / 'local.txt').read_text(), 'Keep this local file')
                self.assertEqual((destination / 'published.txt').read_text(), 'New revision')
                second = bundle_delivery.deliver('operator@source', '/published', staging, destination)
                self.assertEqual(second['files'], 0)
                self.assertEqual(second['unchanged'], 1)

    def test_unverified_source_never_promotes_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(bundle_delivery.archive_mirror, 'Remote'), patch.object(bundle_delivery.archive_mirror, 'mirror', return_value={'status': 'failed'}):
                with self.assertRaises(RuntimeError):
                    bundle_delivery.deliver('operator@source', '/published', root / 'stage', root / 'destination')
            self.assertFalse((root / 'destination').exists())

    def test_destination_link_refuses_before_overwriting_its_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            current = root / 'stage' / 'current'
            current.mkdir(parents=True)
            (current / 'published.txt').write_text('Source')
            destination = root / 'destination'
            destination.mkdir()
            outside = root / 'outside.txt'
            outside.write_text('Keep')
            (destination / 'published.txt').symlink_to(outside)
            with patch.object(bundle_delivery.archive_mirror, 'Remote'), patch.object(bundle_delivery.archive_mirror, 'mirror', return_value={'status': 'verified'}):
                with self.assertRaises(RuntimeError):
                    bundle_delivery.deliver('operator@source', '/published', root / 'stage', destination)
            self.assertEqual(outside.read_text(), 'Keep')


if __name__ == '__main__':
    unittest.main()
