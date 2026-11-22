"""Read bounded Linux kernel topology; report hashes, never storage acceptance.

Only retained source descriptors select mounts/devices. These internal read
ports have no CLI/configuration override. The OS account and its kernel view
are trusted, as for native restoration; this is not hardware attestation.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys

from archive_preservation import digest

CONTRACT = 'secretary.archive-storage-topology/v1'
SCOPE = 'selected-current-review-files-kernel-device-identities'
MAX_DISKS, MAX_NODES, MAX_DEPTH = 32, 128, 16
MAX_MOUNTS, MAX_MOUNT_BYTES = 8192, 4 * 1024 * 1024
SYS_ROOT = Path('/sys')
MOUNTINFO_FILE = Path('/proc/self/mountinfo')
FDINFO_ROOT = Path('/proc/self/fdinfo')
DEVICE = re.compile(r'([0-9]{1,7}):([0-9]{1,7})')
WWID = re.compile(r'(?:NAA\.(?:[0-9A-F]{16}|[0-9A-F]{32})|EUI\.(?:[0-9A-F]{16}|[0-9A-F]{24}|[0-9A-F]{32}))')
UNSAFE = re.compile(r'(?:^|[/_-])(?:virtual|virtio[^/]*|xen|vmbus|iscsi[^/]*|session[0-9]+|'
                    r'rport[^/]*|fc_host|nvme-fabrics|rbd[0-9]*|nbd[0-9]*|loop[0-9]*)(?:[/_-]|$)', re.I)
PLACEHOLDERS = {'unknown', 'none', 'null', 'default', 'not specified', 'to be filled by o.e.m.'}


class Unqualified(RuntimeError):
    def __init__(self, code):
        self.code = code


class KernelMetadata:
    """Native read-only ports. Tests replace this class with synthetic metadata."""
    def __init__(self):
        self.sys, self.mountinfo, self.fdinfo = SYS_ROOT, MOUNTINFO_FILE, FDINFO_ROOT
        self.observations = []

    def read(self, path, limit=512, *, optional=False):
        try:
            with path.open('rb') as stream:
                raw = stream.read(limit + 1)
        except FileNotFoundError:
            if optional:
                self.observations.append(('absent', str(path)))
                return None
            raise
        if len(raw) > limit or b'\x00' in raw:
            raise Unqualified('kernel_metadata_invalid')
        value = raw.decode('ascii')
        self.observations.append(('read', str(path), value))
        return value

    def resolve(self, path):
        try:
            value = path.resolve(strict=True)
        except RuntimeError:
            raise Unqualified('device_topology_ambiguous') from None
        if not value.is_relative_to(self.sys / 'devices') or len(str(value)) > 4096:
            raise Unqualified('device_topology_unsupported')
        self.observations.append(('resolve', str(path), str(value)))
        return value

    def entries(self, path):
        with os.scandir(path) as entries:
            names = []
            for entry in entries:
                if len(names) >= MAX_DISKS:
                    raise Unqualified('device_topology_too_large')
                names.append(entry.name)
        names.sort()
        self.observations.append(('entries', str(path), names))
        return names

    def device(self, fd):
        info = os.fstat(fd)
        value = f'{os.major(info.st_dev)}:{os.minor(info.st_dev)}'
        self.observations.append(('device', fd, value))
        return value

    def mount_id(self, fd):
        text = self.read(self.fdinfo / str(fd), 8192)
        ids = re.findall(r'^mnt_id:\s*([0-9]{1,12})\s*$', text, re.M)
        if len(ids) != 1:
            raise Unqualified('mount_metadata_invalid')
        return ids[0]

    def mounts(self):
        text = self.read(self.mountinfo, MAX_MOUNT_BYTES)
        lines = text.splitlines()
        if len(lines) > MAX_MOUNTS:
            raise Unqualified('mount_metadata_too_large')
        result = {}
        for line in lines:
            fields = line.split()
            if len(fields) < 10 or fields.count('-') != 1:
                raise Unqualified('mount_metadata_invalid')
            split = fields.index('-')
            if split < 6 or len(fields) != split + 4 or not fields[0].isdigit() \
                    or not DEVICE.fullmatch(fields[2]) or fields[0] in result:
                raise Unqualified('mount_metadata_invalid')
            result[fields[0]] = (fields[2], fields[split + 1])
        return result

    def signature(self):
        return digest(json.dumps(self.observations, separators=(',', ':'), sort_keys=True).encode())


def identifier(value):
    if value is None:
        raise Unqualified('disk_identifier_unavailable')
    value = ' '.join(value.strip().split()).upper()
    if not 3 <= len(value) <= 256 or value.lower() in PLACEHOLDERS \
            or not re.fullmatch(r'[A-Z0-9 ._:+/-]+', value) \
            or not re.search(r'[1-9A-Z]', value.replace('0', '').replace('-', '').replace('.', '')):
        raise Unqualified('disk_identifier_invalid')
    return value


def hardware_text(value):
    value = identifier(value)
    if re.search(r'VIRTUAL|QEMU|VMWARE|VBOX|VIRTIO|LOGICAL|RAID|ELASTIC BLOCK|AMAZON|MSFT', value):
        raise Unqualified('device_transport_unsupported')
    return value


def physical_id(metadata, path):
    """Collapse NVMe namespaces to their physical PCIe controller identity."""
    relative = path.relative_to(metadata.sys / 'devices').as_posix()
    if UNSAFE.search(relative) or not re.search(r'(?:^|/)pci[0-9a-f]{4}:', relative):
        raise Unqualified('device_transport_unsupported')
    controllers = [parent for parent in path.parents if re.fullmatch(r'nvme[0-9]+', parent.name)]
    if controllers:
        if len(controllers) != 1:
            raise Unqualified('device_topology_ambiguous')
        controller = controllers[0]
        if metadata.read(controller / 'transport').strip() != 'pcie':
            raise Unqualified('device_transport_unsupported')
        serial = identifier(metadata.read(controller / 'serial'))
        model = hardware_text(metadata.read(controller / 'model'))
        vendor = metadata.read(controller / 'device' / 'vendor').strip().lower()
        if not re.fullmatch(r'0x[0-9a-f]{4}', vendor) or vendor in ('0x0000', '0xffff'):
            raise Unqualified('disk_identifier_invalid')
        identity = ['nvme-controller', vendor, model, serial]
    else:
        device = metadata.resolve(path / 'device')
        if UNSAFE.search(device.relative_to(metadata.sys / 'devices').as_posix()):
            raise Unqualified('device_transport_unsupported')
        # Only local ATA/SAS/USB mass-storage drivers are qualified. Unknown
        # SCSI transports, hypervisor disks and fabric HBAs fail closed.
        hosts = [parent for parent in device.parents if re.fullmatch(r'host[0-9]+', parent.name)]
        if len(hosts) != 1:
            raise Unqualified('device_transport_unsupported')
        driver = metadata.read(metadata.sys / 'class' / 'scsi_host' / hosts[0].name / 'proc_name').strip()
        if driver not in {'ahci', 'ata_piix', 'sata_nv', 'sata_sil', 'mpt2sas', 'mpt3sas',
                          'uas', 'usb-storage'}:
            raise Unqualified('device_transport_unsupported')
        if metadata.read(device / 'type').strip() != '0':
            raise Unqualified('device_topology_unsupported')
        vendor = hardware_text(metadata.read(device / 'vendor'))
        model = hardware_text(metadata.read(device / 'model'))
        if 'NVME' in vendor + ' ' + model:
            # A bridge exposes a different identity family than the native
            # NVMe controller. Do not silently qualify those aliases apart.
            raise Unqualified('device_transport_unsupported')
        candidates = [metadata.read(p, optional=True) for p in (path / 'wwid', device / 'wwid')]
        wwids = {identifier(value) for value in candidates if value is not None}
        if len(wwids) > 1:
            raise Unqualified('device_topology_ambiguous')
        if not wwids:
            raise Unqualified('disk_identifier_unavailable')
        wwid = next(iter(wwids))
        # A fixed identity family prevents the same disk becoming disjoint
        # across hosts when only one host exposes its serial tuple.
        if not WWID.fullmatch(wwid) or not re.search(r'[1-9A-F]', wwid.split('.', 1)[1]):
            raise Unqualified('disk_identifier_invalid')
        identity = ['whole-disk-wwid', wwid]
    return digest(json.dumps(identity, separators=(',', ':')).encode())


def disks(metadata, device, seen, active, depth=0):
    if depth > MAX_DEPTH:
        raise Unqualified('device_topology_too_large')
    if device in active:
        raise Unqualified('device_topology_ambiguous')
    if device in seen:
        return seen[device]
    if len(seen) + len(active) >= MAX_NODES:
        raise Unqualified('device_topology_too_large')
    if not DEVICE.fullmatch(device):
        raise Unqualified('device_metadata_invalid')
    active.add(device)
    path = metadata.resolve(metadata.sys / 'dev' / 'block' / device)
    if metadata.read(path / 'dev').strip() != device:
        raise Unqualified('device_metadata_invalid')
    partition = metadata.read(path / 'partition', optional=True)
    if partition is not None:
        if not re.fullmatch(r'[1-9][0-9]{0,7}\s*', partition):
            raise Unqualified('device_metadata_invalid')
        parent = metadata.read(path.parent / 'dev').strip()
        if metadata.resolve(metadata.sys / 'dev' / 'block' / parent) != path.parent:
            raise Unqualified('device_topology_ambiguous')
        result = disks(metadata, parent, seen, active, depth + 1)
    else:
        slaves = metadata.entries(path / 'slaves')
        if slaves:
            result = set()
            for name in slaves:
                slave = metadata.resolve(path / 'slaves' / name)
                child = metadata.read(slave / 'dev').strip()
                if metadata.resolve(metadata.sys / 'dev' / 'block' / child) != slave:
                    raise Unqualified('device_topology_ambiguous')
                result.update(disks(metadata, child, seen, active, depth + 1))
        else:
            result = {physical_id(metadata, path)}
    if not 1 <= len(result) <= MAX_DISKS:
        raise Unqualified('device_topology_too_large')
    active.remove(device)
    seen[device] = result
    return result


def capture(files):
    """Return sanitized observations plus a private comparison fingerprint."""
    metadata = KernelMetadata()
    ids, blockers = set(), set()
    try:
        if sys.platform != 'linux':
            raise Unqualified('kernel_metadata_unsupported')
        mounts = metadata.mounts()
        descriptors = [files.fd, *(record[0] for _, record in sorted(files.files.items()))]
        if not 2 <= len(descriptors) <= 257:
            raise Unqualified('source_file_set_invalid')
        for fd in descriptors:
            try:
                device = metadata.device(fd)
                mount = mounts.get(metadata.mount_id(fd))
                if mount is None or mount[0] != device:
                    raise Unqualified('mount_metadata_invalid')
                if mount[1] not in ('ext4', 'xfs'):
                    raise Unqualified('mount_type_unsupported')
                # Re-read each device chain for every FD, including archive
                # root; caching across descriptors would hide late remaps.
                ids.update(disks(metadata, device, {}, set()))
                if len(ids) > MAX_DISKS:
                    raise Unqualified('device_topology_too_large')
            except Unqualified as error:
                blockers.add(error.code)
            except (OSError, UnicodeError, ValueError, RecursionError):
                blockers.add('kernel_metadata_unavailable')
    except Unqualified as error:
        blockers.add(error.code)
    except (OSError, UnicodeError, ValueError, RecursionError):
        blockers.add('kernel_metadata_unavailable')
    if not ids and not blockers:
        blockers.add('disk_identifier_unavailable')
    return {'physicalDiskIdsSha256': sorted(ids) if not blockers else [],
            'blockers': sorted(blockers)}, metadata.signature()
