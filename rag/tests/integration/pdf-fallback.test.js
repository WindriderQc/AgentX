const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

// Synthetic, uncompressed PDF: no personal document or external fixture required.
function makePdf() {
  const content = 'BT /F1 12 Tf 72 720 Td (AgentX PDF fallback works) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

describe('PDF fallback with the installed pdf-parse package', () => {
  let directory;

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-pdf-test-'));
    await fs.writeFile(path.join(directory, 'sample.pdf'), makePdf());
  });

  afterAll(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('extracts a real PDF when pdftotext is unavailable and exits without open workers', async () => {
    // A normal Node process exercises pdf.js ESM workers as deployed, outside
    // Jest's VM module loader. Neither pdf-parse nor the filesystem is mocked.
    const script = `
      const { extractTextFromFile } = require(process.argv[1]);
      extractTextFromFile(process.argv[2], 'pdf', {
        commandRunner: async () => { throw Object.assign(new Error('pdftotext absent'), { code: 'ENOENT' }); }
      }).then(text => console.log('PDF_RESULT:' + JSON.stringify(text)))
        .catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const { stdout } = await execFileAsync(process.execPath, [
      '-e', script,
      path.resolve(__dirname, '../../src/services/ingestWorker.js'),
      path.join(directory, 'sample.pdf'),
    ], { timeout: 15000, windowsHide: true });

    const result = stdout.split(/\r?\n/).find(line => line.startsWith('PDF_RESULT:'));
    expect(result).toBeDefined();
    expect(JSON.parse(result.slice('PDF_RESULT:'.length))).toContain('AgentX PDF fallback works');
  }, 20000);
});
