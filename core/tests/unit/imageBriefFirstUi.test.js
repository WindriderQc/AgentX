'use strict';
const ejs = require('ejs');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const viewPath = path.join(root, 'views/pages/images.ejs');
const page = ejs.render(fs.readFileSync(viewPath, 'utf8'), {}, { filename: viewPath });

function imageFormSegment(html) {
  const start = html.indexOf('<form id="image-form"');
  const end = html.indexOf('</form>', start);
  if (start === -1 || end === -1 || end < start) throw new Error('image-form is not a well-formed form element');
  return html.slice(start, end);
}

test('the image brief is the first control of the compose form, followed by the format', () => {
  const form = imageFormSegment(page);
  const brief = form.indexOf('id="image-prompt"');
  const format = form.indexOf('id="image-size"');
  const recipe = form.indexOf('id="image-profile"');
  const references = form.indexOf('id="image-references"');
  const create = form.indexOf('id="image-create"');
  expect(brief).toBeGreaterThanOrEqual(0);
  expect(format).toBeGreaterThan(brief);
  expect(recipe).toBeGreaterThan(format);
  expect(references).toBeGreaterThan(recipe);
  expect(create).toBeGreaterThan(references);
  const controls = [...form.matchAll(/<(?:textarea|input|select)\b[^>]*\bid="([^"]+)"/g)];
  expect(controls.slice(0, 2).map(match => match[1])).toEqual(['image-prompt', 'image-size']);
});
test('the imageX/Hermès advice sits in the same space as the brief and format', () => {
  const form = imageFormSegment(page);
  const brief = form.indexOf('id="image-prompt"');
  const format = form.indexOf('id="image-size"');
  const advice = form.indexOf('id="image-advice"');
  const plan = form.indexOf('id="imagex-plan"');
  const planningHelp = form.indexOf('id="imagex-planning-help"');
  expect(format).toBeGreaterThan(brief);
  expect(advice).toBeGreaterThan(format);
  expect(plan).toBeGreaterThan(advice);
  expect(planningHelp).toBeGreaterThan(plan);
  expect(form).toContain('type="button"');
  expect(form.slice(advice, planningHelp)).toContain('Affiner mon brief');
});
test('the specialist conversation remains outside the brief form with unique advice controls', () => {
  const form = imageFormSegment(page);
  expect(form).not.toContain('id="imagex-chat-form"');
  expect(form.match(/<form\b/g)).toHaveLength(1);
  expect(page).toContain('id="imagex-chat-form"');
  expect(page).toContain('id="imagex-message"');
  expect(page).toContain('id="imagex-session"');
  const pageForms = page.match(/<form\b/g) || [];
  expect(pageForms).toHaveLength(2);
  const expertStart = page.indexOf('<details class="imagex-panel"');
  expect(expertStart).toBeGreaterThan(page.indexOf('</form>'));
  for (const id of ['image-advice', 'image-size', 'imagex-plan', 'imagex-explore', 'imagex-planning-help']) {
    expect(page.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1);
  }
  for (const id of ['imagex-recovery', 'imagex-stop', 'imagex-proposal', 'imagex-plan-instruction']) {
    expect(form).toContain(`id="${id}"`);
  }
});
test('references, constraints, sketch and generation keep their place after the format', () => {
  const form = imageFormSegment(page);
  for (const id of ['image-constraints', 'image-layout-guide', 'image-seed', 'image-starter']) {
    expect(form.indexOf(id)).toBeGreaterThan(form.indexOf('id="image-size"'));
  }
  for (const id of ['image-gallery', 'image-search', 'image-text-editor', 'image-compare']) {
    expect(page).toContain(`id="${id}"`);
  }
});
