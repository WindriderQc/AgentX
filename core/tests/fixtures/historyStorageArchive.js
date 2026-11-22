'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { reviewArchive } = require('./historyReviewArchive');
const { control: findingControl } = require('./historyFindingArchive');
const { SecretaryMailControl } = require('../../integrations/runtime-bridges/secretary-mail-control');
const { SecretaryPreservationControl } = require('../../integrations/runtime-bridges/secretary-preservation-control');

async function storageArchive() {
  const fixture = await reviewArchive(), calls = [], kernels = {};
  try {
    for (const [index, copy] of ['primary', 'mirror'].entries()) {
      const directory = path.join(path.dirname(fixture.roots[copy]), `kernel-${copy}`);
      const sys = path.join(directory, 'sys');
      const scsi = path.join(sys, 'devices/pci0000:00/0000:00:01.0/ata1/host0/target0:0:0/0:0:0');
      const disk = path.join(scsi, 'block/sda');
      await fs.mkdir(path.join(disk, 'slaves'), { recursive: true });
      const fd = await fs.open(fixture.roots[copy], 'r'); let mount;
      try {
        const info = await fs.readFile(`/proc/self/fdinfo/${fd.fd}`, 'utf8');
        const id = info.match(/^mnt_id:\s*(\d+)$/m)[1];
        mount = (await fs.readFile('/proc/self/mountinfo', 'utf8')).split('\n').find(line => line.startsWith(id + ' ')).split(' ');
      } finally { await fd.close(); }
      const device = mount[2]; mount[mount.indexOf('-') + 1] = 'ext4';
      const mountinfo = path.join(directory, 'mountinfo'); await fs.writeFile(mountinfo, mount.join(' ') + '\n');
      for (const [file, value] of [['dev', device], ['wwid', `naa.500000000000000${index + 1}`]]) await fs.writeFile(path.join(disk, file), value + '\n');
      for (const [file, value] of [['type', '0'], ['vendor', 'SyntheticVendor'], ['model', 'SyntheticModel']]) await fs.writeFile(path.join(scsi, file), value + '\n');
      await fs.symlink(scsi, path.join(disk, 'device'), 'dir');
      await fs.mkdir(path.join(sys, 'dev/block'), { recursive: true }); await fs.symlink(disk, path.join(sys, 'dev/block', device), 'dir');
      await fs.mkdir(path.join(sys, 'class/scsi_host/host0'), { recursive: true });
      await fs.writeFile(path.join(sys, 'class/scsi_host/host0/proc_name'), 'ahci\n');
      kernels[copy] = { sys, mountinfo, disk };
    }
    // Only OS identity inputs are synthetic. Real source FDs, native topology
    // parsing, archive/MIME/review readers and guarded restoration execute.
    const program = ['import sys', 'from pathlib import Path', 'sys.path.insert(0,sys.argv[1])',
      'import archive_preservation as native', 'native.MACHINE_ID_FILE=Path(sys.argv[2])',
      'import archive_storage_topology as topology', 'topology.SYS_ROOT=Path(sys.argv[4])', 'topology.MOUNTINFO_FILE=Path(sys.argv[5])',
      'import secretary_mail_desk as desk', 'raise SystemExit(desk.main(["--evidence-root",sys.argv[3],*sys.argv[6:]]))'].join('\n');
    const reader = copy => new SecretaryMailControl({ sshTarget: copy + '.example.invalid', remoteRoot: '/opt/product',
      sshRunner: async (host, command) => {
        calls.push({ copy, host, command }); const args = command.split(' ');
        if (args[0] !== '/usr/bin/python3' || args[1] !== '/opt/product/integrations/secretary/secretary_mail_desk.py' || args[2] !== 'storage-evidence') throw new Error('Unexpected native storage command');
        return promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
          path.resolve(__dirname, '../../../integrations/secretary'), fixture.machines[copy], fixture.roots[copy],
          kernels[copy].sys, kernels[copy].mountinfo, ...args.slice(2)], { timeout: 15000, maxBuffer: 128 * 1024,
          env: { ...process.env, TMPDIR: fixture.temporaryRoot, OPENCLAW_CONFIG_PATH: path.join(fixture.temporaryRoot, 'no-runtime-config.json') } });
      } });
    return { ...fixture, kernels, calls, reviewControl: fixture.control,
      findings: findingControl(fixture.roots.primary, path.join(fixture.temporaryRoot, 'no-runtime-config.json')),
      control: new SecretaryPreservationControl({ primary: reader('primary'), mirror: reader('mirror') }) };
  } catch (error) { await fixture.cleanup(); throw error; }
}

module.exports = { storageArchive };
