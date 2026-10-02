'use strict';
// Real pdf-parse worker runs outside Jest's VM, against its disposable database.
function pdf(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`];
  let result = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return result;
}
async function main() {
  const assert = require('node:assert/strict');
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI_TEST);
  try {
    const store = require('../../src/services/conversationAttachmentService').forConversation(JSON.parse(process.argv[2]));
    const payload = text => ({ name: 'synthetic.pdf', dataUrl: `data:application/pdf;base64,${Buffer.from(pdf(text)).toString('base64')}` });
    const ref = await store.upload(payload('AgentX synthetic PDF attachment'));
    const messages = await store.prepare([{ role: 'user', content: 'Read', attachments: [ref] }], 'agentx');
    assert.match(messages[0].content, /AgentX synthetic PDF attachment/);
    assert.ok((await store.download(ref.id)).data.equals(Buffer.from(pdf('AgentX synthetic PDF attachment'))));
    await assert.rejects(store.upload(payload('')), /entre 1 et 24 000/);
    await assert.rejects(store.upload({ name: 'broken.pdf', dataUrl: `data:application/pdf;base64,${Buffer.from('%PDF-broken').toString('base64')}` }), /PDF/);
    process.stdout.write('PDF_ATTACHMENT_OK\n');
  } finally { await mongoose.disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
