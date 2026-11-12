'use strict';

// Windows OpenSSH terminates its session job tree on logout. A detached Node
// child alone does not survive it. WMI creates the fixed native worker outside
// that tree; no arbitrary executable or command comes from the browser.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  { spawn } = require('node:child_process');
const { childResult } = require('./transport.cjs');
const { id } = require('../../core/src/services/photos/phoneLibrary');
function checkedPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /["%!?&|<>^\r\n\0]/.test(value))
    throw new Error('Invalid native worker path');
  return value;
}
async function launchWorker({ requestId, configFile, cacheRoot, worker }) {
  id(requestId);
  const logFile = path.join(cacheRoot, 'phone-jobs', requestId + '.log');
  if (process.platform === 'win32') {
    const exe = checkedPath(process.execPath);
    worker = checkedPath(worker);
    configFile = checkedPath(configFile);
    checkedPath(logFile);
    const line = `cmd.exe /d /s /c ""${exe}" "${worker}" --config "${configFile}" --run ${requestId} < NUL >> "${logFile}" 2>&1"`;
    const script =
      "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$line=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
      Buffer.from(line).toString('base64') +
      "'));$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$line};if($result.ReturnValue -ne 0){throw ('Native worker launch refused: '+$result.ReturnValue)};@{pid=[int]$result.ProcessId}|ConvertTo-Json -Compress";
    const result = await childResult(
      spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { windowsHide: true },
      ),
      65536,
      20000,
    );
    if (!Number.isInteger(result.pid) || result.pid < 1)
      throw new Error('Native worker returned no process identity');
    return result.pid;
  }
  const log = await fs.open(logFile, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [worker, '--config', configFile, '--run', requestId], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return child.pid;
  } finally {
    await log.close();
  }
}
module.exports = { launchWorker };
