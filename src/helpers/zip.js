const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function escapePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function extractZipArchive(zipPath, destinationDir, { timeoutMs = 60000 } = {}) {
  await fs.mkdir(destinationDir, { recursive: true });

  if (process.platform === 'win32') {
    const command = `Expand-Archive -LiteralPath ${escapePowerShellLiteral(zipPath)} -DestinationPath ${escapePowerShellLiteral(destinationDir)} -Force`;
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      }
    );

    return { stdout, stderr };
  }

  const { stdout, stderr } = await execFileAsync(
    'unzip',
    ['-o', zipPath, '-d', destinationDir],
    {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    }
  );

  return { stdout, stderr };
}

module.exports = {
  extractZipArchive
};
