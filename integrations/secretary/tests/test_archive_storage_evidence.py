"""Real restoration with synthetic, explicitly bounded Linux kernel metadata."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive_preservation as source
import archive_restoration as disk
import archive_review_restoration as review
from archive_review_packet import ReviewPacketError
import archive_storage_evidence as evidence
import archive_storage_topology as topology
import secretary_mail_desk as desk
import test_archive_review_restoration as fixtures

MID, TID = fixtures.MID, fixtures.TID


class KernelFixture:
    def __init__(self, root):
        self.root = root
        self.sys, self.proc = root / 'sys', root / 'proc'
        self.devices = self.sys / 'devices'
        self.devices.mkdir(parents=True)
        (self.sys / 'dev' / 'block').mkdir(parents=True)
        (self.proc / 'self' / 'fdinfo').mkdir(parents=True)
        self.mounts = self.proc / 'self' / 'mountinfo'
        self.mounts.write_text('10 1 8:1 / /archive rw - ext4 /dev/example rw\n')
        self.mapping = {}
        self.default_device, self.default_mount = '8:1', '10'
        self.paths = {}
        self.scsi('sda', '8:0', 'naa.5000000000000001')
        self.partition('8:0', 'sda1', '8:1')

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def register(self, device, path):
        path.mkdir(parents=True, exist_ok=True)
        self.write(path / 'dev', device + '\n')
        (path / 'slaves').mkdir(exist_ok=True)
        (self.sys / 'dev' / 'block' / device).symlink_to(path, target_is_directory=True)
        self.paths[device] = path
        return path

    def scsi(self, name, device, wwid, *, driver='ahci'):
        port = self.devices / 'pci0000:00' / '0000:00:01.0' / 'ata1' / 'host0' / 'target0:0:0' / ('0:0:' + name)
        path = self.register(device, port / 'block' / name)
        (path / 'device').symlink_to(port, target_is_directory=True)
        self.write(self.sys / 'class' / 'scsi_host' / 'host0' / 'proc_name', driver + '\n')
        self.write(port / 'type', '0\n')
        self.write(port / 'vendor', 'SyntheticVendor\n')
        self.write(port / 'model', 'SyntheticModel\n')
        self.write(port / 'serial', 'SyntheticSerial' + name + '\n')
        if wwid is not None:
            self.write(path / 'wwid', wwid + '\n')
        return path

    def partition(self, parent, name, device):
        path = self.register(device, self.paths[parent] / name)
        self.write(path / 'partition', '1\n')
        return path

    def nvme(self, namespace, device, *, controller='nvme0', serial='SyntheticNVMeSerial', transport='pcie'):
        ctrl = self.devices / 'pci0000:00' / '0000:00:02.0' / 'nvme' / controller
        self.write(ctrl / 'serial', serial + '\n')
        self.write(ctrl / 'model', 'SyntheticNVMeModel\n')
        self.write(ctrl / 'transport', transport + '\n')
        self.write(ctrl / 'device' / 'vendor', '0x1234\n')
        return self.register(device, ctrl / namespace)

    def stack(self, name, device, children):
        path = self.register(device, self.devices / 'virtual' / 'block' / name)
        for index, child in enumerate(children):
            (path / 'slaves' / ('slave' + str(index))).symlink_to(self.paths[child], target_is_directory=True)
        return path

    def select(self, device, *, fstype='ext4', mount='10'):
        self.default_device, self.default_mount = device, mount
        self.mounts.write_text(f'{mount} 1 {device} / /archive rw - {fstype} /dev/example rw\n')

    def prepare(self, files):
        for fd in [files.fd, *(row[0] for row in files.files.values())]:
            device, mount = self.mapping.get(fd, (self.default_device, self.default_mount))
            self.write(self.proc / 'self' / 'fdinfo' / str(fd), f'pos:\t0\nflags:\t0100000\nmnt_id:\t{mount}\n')

    def reader(self):
        fixture = self
        class SyntheticMetadata(topology.KernelMetadata):
            def __init__(self):
                super().__init__()
                self.sys, self.mountinfo = fixture.sys, fixture.mounts
                self.fdinfo = fixture.proc / 'self' / 'fdinfo'
            def device(self, fd):
                value = fixture.mapping.get(fd, (fixture.default_device, fixture.default_mount))[0]
                self.observations.append(('device', fd, value))
                return value
        # Capture the unpatched base to avoid a recursive class definition.
        return SyntheticMetadata()


@unittest.skipUnless(disk.NATIVE_PLATFORM and disk.RENAME_NOREPLACE is not None, 'Linux native custody required')
class StorageEvidenceTests(unittest.TestCase):
    save = fixtures.ReviewRestorationTests.save
    set_raw = fixtures.ReviewRestorationTests.set_raw
    empty_scratch = fixtures.ReviewRestorationTests.empty_scratch
    graph_files = fixtures.ReviewRestorationTests.graph_files
    setUp = fixtures.ReviewRestorationTests.setUp

    def kernel(self):
        return KernelFixture(Path(self.temp.name) / 'kernel')

    def probe(self, kernel=None, *, mutate=None):
        if kernel is None:
            return evidence.probe(self.root, MID, TID, self.sha, self.request)
        original_capture = topology.capture
        reader = kernel.reader()  # Construct before patching the factory.
        calls = []
        def capture(files):
            kernel.prepare(files)
            calls.append([files.fd, *(row[0] for row in files.files.values())])
            if mutate:
                mutate(files, len(calls))
            # Each capture owns an independent transcript, as native does.
            reader.observations = []
            with patch.object(topology, 'KernelMetadata', return_value=reader):
                return original_capture(files)
        with patch.object(topology, 'capture', side_effect=capture):
            value = evidence.probe(self.root, MID, TID, self.sha, self.request)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(len(calls[0]), value['storage']['files'] + 1)
        return value

    def observed(self, proof, count=1):
        storage = proof['storage']
        self.assertEqual(storage['contract'], topology.CONTRACT)
        self.assertEqual(storage['scope'], topology.SCOPE)
        self.assertEqual(storage['status'], 'observed_local_devices')
        self.assertEqual(storage['files'], proof['restoration']['filesCopied'])
        self.assertEqual(storage['filesSha256'], proof['restoration']['sourceFilesSha256'])
        self.assertEqual(len(storage['physicalDiskIdsSha256']), count)
        self.assertEqual(storage['physicalDiskIdsSha256'], sorted(set(storage['physicalDiskIdsSha256'])))
        self.assertTrue(all(source.HASH.fullmatch(value) for value in storage['physicalDiskIdsSha256']))
        self.assertEqual(storage['blockers'], [])
        self.assertIs(storage['physicalIndependenceAccepted'], False)
        self.empty_scratch()

    def unqualified(self, proof, code=None):
        self.assertEqual(proof['storage']['status'], 'unqualified')
        self.assertEqual(proof['storage']['physicalDiskIdsSha256'], [])
        self.assertTrue(proof['storage']['blockers'])
        if code: self.assertIn(code, proof['storage']['blockers'])
        self.assertIs(proof['storage']['physicalIndependenceAccepted'], False)
        self.empty_scratch()

    def test_real_restore_binds_complete_file_set_and_leaks_no_raw_metadata(self):
        kernel = self.kernel()
        before = {p: (p.read_bytes(), source.stamp(p.stat())) for p in self.root.rglob('*') if p.is_file()}
        proof = self.probe(kernel)
        self.observed(proof)
        self.assertEqual(proof['contract'], evidence.CONTRACT)
        self.assertEqual({p: (p.read_bytes(), source.stamp(p.stat())) for p in before}, before)
        encoded = json.dumps(proof)
        for hidden in ('naa.', 'SyntheticVendor', 'SyntheticSerial', 'SyntheticModel', 'pci0000', '/dev/', str(kernel.root), str(self.root)):
            self.assertNotIn(hidden, encoded)
        legacy = review.probe(self.root, MID, TID, self.sha, self.request)
        self.assertEqual({**proof, 'contract': review.CONTRACT, 'storage': None}, {**legacy, 'storage': None})

    def test_whole_disk_aliases_and_partitions_have_same_global_id(self):
        kernel = self.kernel()
        first = self.probe(kernel); self.observed(first)
        kernel.scsi('sdb', '8:16', 'naa.5000000000000001')
        kernel.partition('8:16', 'sdb1', '8:17')
        kernel.stack('dm-0', '253:0', ['8:1', '8:17'])
        kernel.select('253:0', fstype='xfs')
        second = self.probe(kernel); self.observed(second)
        self.assertEqual(first['storage']['physicalDiskIdsSha256'], second['storage']['physicalDiskIdsSha256'])
        # Same kernel IDs in a separate machine/path fixture remain global.
        other = KernelFixture(Path(self.temp.name) / 'other-kernel')
        third = self.probe(other)
        self.assertEqual(first['storage']['physicalDiskIdsSha256'], third['storage']['physicalDiskIdsSha256'])

    def test_nvme_namespaces_collapse_to_controller_and_separate_serials_do_not(self):
        kernel = self.kernel()
        kernel.nvme('nvme0n1', '259:0'); kernel.nvme('nvme0n2', '259:1')
        kernel.stack('dm-0', '253:0', ['259:0', '259:1']); kernel.select('253:0')
        first = self.probe(kernel); self.observed(first)
        kernel.nvme('nvme1n1', '259:2', controller='nvme1')
        kernel.stack('dm-alias', '253:2', ['259:0', '259:2']); kernel.select('253:2')
        alias = self.probe(kernel); self.observed(alias)
        self.assertEqual(alias['storage']['physicalDiskIdsSha256'], first['storage']['physicalDiskIdsSha256'])
        (kernel.paths['259:2'].parent / 'serial').write_text('OtherSyntheticSerial')
        kernel.stack('dm-1', '253:1', ['259:0', '259:2']); kernel.select('253:1')
        self.observed(self.probe(kernel), 2)

    def test_all_source_fds_including_root_must_qualify(self):
        kernel = self.kernel()
        def bad_root(files, number):
            kernel.mapping[files.fd] = ('8:1', '999')
            kernel.prepare(files)
        self.unqualified(self.probe(kernel, mutate=bad_root), 'mount_metadata_invalid')
        kernel.mapping.clear()
        def bad_one_file(files, number):
            kernel.mapping[next(iter(files.files.values()))[0]] = ('8:1', '999')
            kernel.prepare(files)
        self.unqualified(self.probe(kernel, mutate=bad_one_file), 'mount_metadata_invalid')

    def test_network_overlay_loop_virtual_fabric_and_unknown_driver_refuse(self):
        kernel = self.kernel()
        for fstype in ('nfs', 'nfs4', 'cifs', 'overlay', 'tmpfs', 'btrfs', 'fuse.sshfs'):
            kernel.select('8:1', fstype=fstype)
            self.unqualified(self.probe(kernel), 'mount_type_unsupported')
        kernel.register('7:0', kernel.devices / 'virtual' / 'block' / 'loop0')
        kernel.select('7:0'); self.unqualified(self.probe(kernel), 'device_transport_unsupported')
        kernel.nvme('nvme0n1', '259:0', transport='tcp'); kernel.select('259:0')
        self.unqualified(self.probe(kernel), 'device_transport_unsupported')
        kernel.select('8:1')
        host = kernel.sys / 'class' / 'scsi_host' / 'host0' / 'proc_name'
        for driver in ('iscsi_tcp', 'qla2xxx', 'virtio_scsi', 'megaraid_sas', 'unknown'):
            host.write_text(driver)
            self.unqualified(self.probe(kernel), 'device_transport_unsupported')
        host.write_text('ahci')
        model = (kernel.paths['8:0'] / 'device').resolve() / 'model'
        for virtual in ('QEMU HARDDISK', 'USB NVMe bridge'):
            model.write_text(virtual)
            self.unqualified(self.probe(kernel), 'device_transport_unsupported')

    def test_missing_weak_conflicting_or_malformed_disk_ids_refuse(self):
        kernel = self.kernel(); path = kernel.paths['8:0']; device = (path / 'device').resolve()
        for value in ('unknown', 'naa.0000000000000000', 'naa.50000000000000011', 'raw-arbitrary-id', 'naa.' + '1' * 600, 'naa.5000000000000001\x00'):
            (path / 'wwid').write_text(value)
            self.unqualified(self.probe(kernel))
        (path / 'wwid').write_text('naa.5000000000000001')
        (device / 'wwid').write_text('naa.5000000000000002')
        self.unqualified(self.probe(kernel), 'device_topology_ambiguous')
        (device / 'wwid').unlink(); (path / 'wwid').unlink()
        self.unqualified(self.probe(kernel), 'disk_identifier_unavailable')  # No serial fallback across ID families.
        kernel.nvme('nvme0n1', '259:0', serial='00000000'); kernel.select('259:0')
        self.unqualified(self.probe(kernel), 'disk_identifier_invalid')
        (kernel.paths['259:0'].parent / 'serial').unlink()
        self.unqualified(self.probe(kernel), 'kernel_metadata_unavailable')

    def test_late_native_identity_or_mount_change_removes_every_id(self):
        kernel = self.kernel()
        def changed(files, number):
            if number == 2: (kernel.paths['8:0'] / 'wwid').write_text('naa.5000000000000002')
        self.unqualified(self.probe(kernel, mutate=changed), 'kernel_metadata_changed')
        def mount_changed(files, number):
            if number == 2: kernel.mounts.write_text('10 1 8:1 / /other rw - ext4 /dev/example rw\n')
        self.unqualified(self.probe(kernel, mutate=mount_changed), 'kernel_metadata_changed')

    def test_source_change_inside_or_after_callback_refuses_even_with_stable_metadata(self):
        kernel = self.kernel()
        def changed(files, number):
            if number == 2:
                page = self.root / 'page-reviews' / (self.pages[0]['pageId'] + '.json')
                page.write_bytes(page.read_bytes().replace(b'Synthetic', b'Different'))
        with self.assertRaises(ReviewPacketError): self.probe(kernel, mutate=changed)
        self.empty_scratch()

    def test_optional_review_callback_runs_after_cleanup_with_fds_alive_and_late_fence(self):
        seen = []
        def callback(files, proof):
            self.empty_scratch()
            self.assertEqual(proof['restoration']['temporaryCopyRemoved'], True)
            self.assertEqual(len(files.files), proof['restoration']['filesCopied'])
            for fd in [files.fd, *(record[0] for record in files.files.values())]: os.fstat(fd)
            seen.append(proof)
        proof = review.probe(self.root, MID, TID, self.sha, self.request, inspect_files=callback)
        self.assertEqual(seen, [proof])
        def late(files, proof):
            callback(files, proof)
            page = self.root / 'page-reviews' / (self.pages[0]['pageId'] + '.json')
            page.write_bytes(page.read_bytes().replace(b'Synthetic', b'Different'))
        with self.assertRaises(ReviewPacketError):
            review.probe(self.root, MID, TID, self.sha, self.request, inspect_files=late)
        self.empty_scratch()

    def test_missing_review_graph_never_returns_storage_evidence(self):
        (self.root / 'value-lanes.json').unlink()
        with self.assertRaises(ReviewPacketError): self.probe(self.kernel())
        self.empty_scratch()

    def test_native_read_only_actual_source_on_unsupported_mount(self):
        if not Path('/dev/shm').is_dir(): self.skipTest('Linux shared-memory mount required')
        with tempfile.TemporaryDirectory(dir='/dev/shm') as directory:
            root = Path(directory); path = root / 'source'; path.write_bytes(b'Synthetic actual tmpfs source')
            files = source.SourceFiles(root)
            try:
                files.read('source')
                original = Path.open
                reads = []
                def readonly(path, mode='r', *args, **kwargs):
                    self.assertEqual(mode, 'rb'); reads.append(str(path))
                    return original(path, mode, *args, **kwargs)
                with patch.object(Path, 'open', readonly): value, signature = topology.capture(files)
                self.assertEqual(value['physicalDiskIdsSha256'], [])
                self.assertIn('mount_type_unsupported', value['blockers'])
                self.assertTrue(reads); self.assertRegex(signature, r'^[a-f0-9]{64}$')
                files.finish()
            finally: files.close()
            self.assertEqual(path.read_bytes(), b'Synthetic actual tmpfs source')

    def test_cli_exact_identity_has_no_provider_call_and_rejects_extra_device_arguments(self):
        output = io.StringIO()
        args = ['--evidence-root', str(self.root), 'storage-evidence', '--message', MID, '--thread', TID,
                '--sha256', self.sha, '--request-id', self.request]
        with patch.object(desk, 'native_settings', return_value={}), patch.dict(os.environ, {'TMPDIR': str(self.scratch_base)}, clear=True), \
                patch.object(desk, 'run_gog', side_effect=AssertionError('No provider')), redirect_stdout(output):
            desk.main(args)
        value = json.loads(output.getvalue())
        self.assertEqual(value['status'], 'success')
        self.assertEqual(value['data']['contract'], evidence.CONTRACT)
        for hidden in (str(self.root), '/dev/', 'naa.'):
            self.assertNotIn(hidden, output.getvalue())
        for flag in ('--host', '--device', '--sysfs-root', '--proc-root', '--serial', '--physical-disk-id'):
            output = io.StringIO()
            with redirect_stdout(output), patch('sys.stderr', io.StringIO()): desk.main(args + [flag, 'caller-input'])
            self.assertEqual(json.loads(output.getvalue())['code'], 'SECRETARY_MAIL_BAD_REQUEST')
        self.empty_scratch()


class TopologyMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.kernel = KernelFixture(Path(self.temp.name) / 'kernel')
        self.files = SimpleNamespace(fd=5, files={'source': (6, None, b'')})

    def capture(self):
        self.kernel.prepare(self.files)
        reader = self.kernel.reader()
        with patch.object(topology, 'KernelMetadata', return_value=reader): return topology.capture(self.files)[0]

    def test_malformed_duplicate_missing_and_oversized_native_mount_metadata(self):
        for text in ('malformed', '10 1 8:1 / /archive rw - ext4 /dev/a rw\n' * 2,
                     '10 1 8:1 / /archive rw - ext4 /dev/a rw extra\n', 'x' * (topology.MAX_MOUNT_BYTES + 1)):
            self.kernel.mounts.write_text(text)
            proof = self.capture(); self.assertTrue(proof['blockers']); self.assertEqual(proof['physicalDiskIdsSha256'], [])
        self.kernel.select('8:1')
        with patch.object(topology, 'MAX_MOUNTS', 0): self.assertIn('mount_metadata_too_large', self.capture()['blockers'])
        self.kernel.mounts.unlink()
        self.assertIn('kernel_metadata_unavailable', self.capture()['blockers'])

    def test_bounded_nodes_slaves_and_depth_and_cycles(self):
        self.kernel.stack('dm-0', '253:0', ['8:1']); self.kernel.select('253:0')
        for name, value in (('MAX_DEPTH', 0), ('MAX_NODES', 1), ('MAX_DISKS', 0)):
            with patch.object(topology, name, value): self.assertTrue(self.capture()['blockers'])
        self.kernel.stack('dm-1', '253:1', ['253:0'])
        (self.kernel.paths['253:0'] / 'slaves' / 'cycle').symlink_to(self.kernel.paths['253:1'], target_is_directory=True)
        self.assertIn('device_topology_ambiguous', self.capture()['blockers'])

    def test_cyclic_or_escaping_sysfs_links_are_unqualified(self):
        entry = self.kernel.sys / 'dev' / 'block' / '8:1'
        entry.unlink(); entry.symlink_to(entry)
        self.assertTrue(self.capture()['blockers'])
        entry.unlink(); entry.symlink_to(Path(self.temp.name))
        self.assertIn('device_topology_unsupported', self.capture()['blockers'])

    def test_fdinfo_and_dev_metadata_refuse_ambiguity_and_mismatch(self):
        self.kernel.prepare(self.files)
        reader = self.kernel.reader()
        info = self.kernel.proc / 'self' / 'fdinfo' / '5'
        for content in ('mnt_id: 10\nmnt_id: 11\n', 'mnt_id: invalid\n', 'x' * 9000):
            info.write_text(content)
            with patch.object(topology, 'KernelMetadata', return_value=reader):
                value = topology.capture(self.files)[0]
            self.assertTrue(value['blockers']); self.assertEqual(value['physicalDiskIdsSha256'], [])
        (self.kernel.paths['8:1'] / 'dev').write_text('8:99')
        self.assertIn('device_metadata_invalid', self.capture()['blockers'])


if __name__ == '__main__': unittest.main()
