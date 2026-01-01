# Playwright File Handling Guide

This guide documents the preferred patterns for handling file downloads and uploads in AgentX Playwright tests.

## Downloads (Export)

Use `page.on('download')` to capture the download event, then read the content without saving to disk.

```js
function waitForDownload(page) {
  return new Promise((resolve) => {
    const handler = (download) => {
      page.off('download', handler);
      resolve(download);
    };
    page.on('download', handler);
  });
}

async function readDownloadText(download) {
  const stream = await download.createReadStream();
  if (stream) {
    let content = '';
    for await (const chunk of stream) {
      content += chunk.toString('utf-8');
    }
    return content;
  }

  const filePath = await download.path();
  return fs.readFile(filePath, 'utf-8');
}

const downloadPromise = waitForDownload(page);
await page.click('#exportPromptsBtn');
const download = await downloadPromise;
const json = JSON.parse(await readDownloadText(download));
```

Notes:
- Prefer reading the stream directly so tests do not write download files to disk.
- Use `download.suggestedFilename()` to validate naming.

## Uploads (Import)

Use `page.setInputFiles()` to provide fixture files or in-memory buffers.

```js
// Using a fixture file on disk
await page.setInputFiles('#importFileInput', '/path/to/fixtures/valid-export.json');

// Using an in-memory buffer (useful for export->import loops)
await page.setInputFiles('#importFileInput', {
  name: 'workflow.json',
  mimeType: 'application/json',
  buffer: Buffer.from(jsonString, 'utf-8')
});
```

Notes:
- Prefer fixture files in `tests/e2e/fixtures/` for stable imports.
- For export/import loops, capture the download content and feed it directly as a buffer.
