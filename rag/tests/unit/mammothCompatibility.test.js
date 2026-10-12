const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const mammoth = require('mammoth');
const JSZip = require(require.resolve('jszip', { paths: [path.dirname(require.resolve('mammoth'))] }));

describe('Mammoth with the updated argument parser', () => {
  let directory;
  let docxPath;

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-mammoth-'));
    docxPath = path.join(directory, 'synthetic.docx');
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>');
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>');
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:body><w:p><w:r><w:t>Synthetic document for parser compatibility.</w:t></w:r></w:p></w:body></w:document>');
    await fs.writeFile(docxPath, await zip.generateAsync({ type: 'nodebuffer' }));
  });

  afterAll(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('extracts a DOCX through the library used by ingestion', async () => {
    const result = await mammoth.extractRawText({ path: docxPath });
    expect(result.value.trim()).toBe('Synthetic document for parser compatibility.');
  });

  test('keeps the existing CLI options and conversion working', () => {
    const cli = require.resolve('mammoth/bin/mammoth');
    const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
    expect(help).toContain('--output-format');
    const html = execFileSync(process.execPath, [cli, docxPath, '--output-format', 'html'], { encoding: 'utf8' });
    expect(html.trim()).toBe('<p>Synthetic document for parser compatibility.</p>');
  });
});
