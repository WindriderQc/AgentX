const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/chat/chat-message-render.js'), 'utf8');

describe('chat message sanitizer', () => {
  test('model HTML cannot set element ids', () => {
    const allowed = source.match(/ALLOWED_ATTR: \[([^\]]*)\]/)[1];
    expect(allowed).not.toMatch(/'id'/);
  });

  test('images load only from this origin or inline data', () => {
    expect(source).toContain("DOMPurify.addHook('afterSanitizeAttributes'");
    expect(source).toContain('/^(\\/(?!\\/)|data:image\\/)/i');
  });
});
