'use strict';
// "Proposer une plante" in Ma jungle (#876): every panel state and the child's
// journey, with a synthetic photo and synthetic profiles only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const window = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../public/plant-proposal-kids'), 'utf8'), { window, Promise, encodeURIComponent });
vm.runInNewContext(fs.readFileSync(require.resolve('../public/plant-view'), 'utf8'), { window, Intl, Date });
const { mount, panelHtml, photoDataUrl, errorText } = window.KidsPlantProposal;
const view = window.PlantView;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const child = { id: 'synthetic-a', displayName: 'Synthetic A' };
const rooms = ['Salon', 'Cuisine'];
const SYNTHETIC = 'data:image/png;base64,c3ludGhldGlj';
const waiting = { id: 'p1', state: 'pending', room: 'Salon', photoUrl: '/api/family/plant-proposals/p1/photo?profileId=synthetic-a' };

test('each panel state says what happens next, in big targets and without free text', () => {
  assert.match(panelHtml({ profile: null }, esc), /Choisis ton nom/);
  assert.match(panelHtml({ profile: child, loading: true }, esc), /role="status"/);
  assert.match(panelHtml({ profile: child, unavailable: true }, esc), /data-propose-retry/);

  const idle = panelHtml({ profile: child, rooms }, esc);
  assert.match(idle, /Proposer une plante/); assert.match(idle, /capture="environment"/); assert.match(idle, /accept="image\/\*"/);
  assert.doesNotMatch(idle, /<textarea|type="text"/);

  const draft = panelHtml({ profile: child, rooms, draft: { preview: SYNTHETIC, room: 'Cuisine' } }, esc);
  assert.match(draft, /Elle vit où/);
  assert.match(draft, /data-propose-room="Cuisine" aria-pressed="true"/);
  assert.match(draft, /data-propose-room="Salon" aria-pressed="false"/);
  assert.match(draft, /data-propose-room="" aria-pressed="false">Je ne sais pas/);
  assert.match(draft, /Envoyer à Papa/); assert.match(draft, /Annuler/);
  assert.doesNotMatch(draft, /<input(?![^>]*type="file")|<textarea/);
  assert.match(panelHtml({ profile: child, rooms, busy: true, draft: { preview: SYNTHETIC, room: null } }, esc), /J’envoie…[\s\S]*disabled/);

  assert.match(panelHtml({ profile: child, proposal: waiting }, esc), /Ta plante attend Papa/);
  assert.match(panelHtml({ profile: child, proposal: waiting }, esc), /src="\/api\/family\/plant-proposals\/p1\/photo\?profileId=synthetic-a"/);
  assert.match(panelHtml({ profile: child, proposal: { ...waiting, state: 'opened' } }, esc), /Papa regarde ta plante/);
  const accepted = panelHtml({ profile: child, proposal: { id: 'p1', state: 'accepted', plant: { id: 'p1', nickname: 'Fougère <3>' } } }, esc);
  assert.match(accepted, /Fougère &lt;3&gt; est dans Ma jungle/); assert.match(accepted, /href="\/kids\/plants\?plant=p1"/); assert.match(accepted, /data-propose-seen/);
  const declined = panelHtml({ profile: child, proposal: { id: 'p1', state: 'declined', reply: 'Papa a vu ta plante. <b>Merci</b>' } }, esc);
  assert.match(declined, /Papa a vu ta plante\. &lt;b&gt;Merci&lt;\/b&gt;/); assert.match(declined, /data-propose-seen/);
  assert.match(panelHtml({ profile: child, rooms, message: 'Ta photo est trop grosse.' }, esc), /role="alert">Ta photo est trop grosse/);
});

test('errors read as plain words for a child', () => {
  assert.match(errorText({ code: 'PLANT_PHOTO_TOO_LARGE' }), /trop grosse/);
  assert.match(errorText({ status: 413 }), /trop grosse/);
  assert.match(errorText({ code: 'PLANT_PROPOSAL_PENDING' }), /attend déjà/);
  assert.match(errorText({}), /Réessaie/);
});

function fakeHost() { return { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] }; }
function fakeApi(responses) {
  const calls = [];
  const api = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return { api, calls };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a child photographs a plant, picks the room and sends only the photo and the room', async () => {
  const host = fakeHost();
  const { api, calls } = fakeApi([{ rooms, proposal: null }, { proposal: { ...waiting, room: 'Cuisine' } }]);
  const controller = mount({ host, api, esc, profile: () => child, prepare: async () => SYNTHETIC });
  await settle();
  assert.equal(calls[0].url, '/api/family/plant-proposals?profileId=synthetic-a');
  assert.match(host.innerHTML, /Proposer une plante/);
  await controller.choosePhoto({ name: 'synthetic.jpg' });
  assert.match(host.innerHTML, /Elle vit où/);
  controller.chooseRoom('Cuisine');
  controller.chooseRoom('Le grenier'); // not a listed room: back to "Je ne sais pas"
  assert.equal(controller.model.draft.room, null);
  controller.chooseRoom('Cuisine');
  await controller.send();
  assert.deepEqual(calls[1], { url: '/api/family/plant-proposals', method: 'POST', body: { profileId: 'synthetic-a', room: 'Cuisine', dataUrl: SYNTHETIC } });
  assert.match(host.innerHTML, /Ta plante attend Papa/);
  assert.equal(controller.model.draft, null);
});

test('a photo that is too large keeps the child on the start button with a message', async () => {
  const host = fakeHost();
  const { api } = fakeApi([{ rooms, proposal: null }]);
  const controller = mount({ host, api, esc, profile: () => child,
    prepare: async () => { throw Object.assign(new Error('too big'), { code: 'PLANT_PHOTO_TOO_LARGE' }); } });
  await settle();
  await controller.choosePhoto({ name: 'synthetic.jpg' });
  assert.match(host.innerHTML, /Proposer une plante/); assert.match(host.innerHTML, /trop grosse/);
});

test('a second tablet or a double tap shows the proposal already waiting instead of failing', async () => {
  const host = fakeHost();
  const pending = Object.assign(new Error('Your plant is already waiting for Dad.'), { status: 409, code: 'PLANT_PROPOSAL_PENDING' });
  const { api, calls } = fakeApi([{ rooms, proposal: null }, pending, { rooms, proposal: waiting }]);
  const controller = mount({ host, api, esc, profile: () => child, prepare: async () => SYNTHETIC });
  await settle();
  await controller.choosePhoto({});
  await controller.send();
  await settle();
  assert.equal(calls.length, 3);
  assert.match(host.innerHTML, /Ta plante attend Papa/);
});

test('a lost send keeps the draft so the child can try again', async () => {
  const host = fakeHost();
  const { api } = fakeApi([{ rooms, proposal: null }, new Error('Network down')]);
  const controller = mount({ host, api, esc, profile: () => child, prepare: async () => SYNTHETIC });
  await settle();
  await controller.choosePhoto({});
  await controller.send();
  assert.ok(controller.model.draft);
  assert.match(host.innerHTML, /Envoyer à Papa/); assert.match(host.innerHTML, /Network down/);
});

test('the child acknowledges Dad\'s answer and can propose again', async () => {
  const host = fakeHost();
  const { api, calls } = fakeApi([{ rooms, proposal: { id: 'p1', state: 'declined', reply: 'Papa a vu ta plante. Merci !' } }, { rooms, proposal: null }]);
  const controller = mount({ host, api, esc, profile: () => child });
  await settle();
  assert.match(host.innerHTML, /Papa a vu ta plante/);
  await controller.acknowledge();
  assert.deepEqual(calls[1], { url: '/api/family/plant-proposals/p1/seen', method: 'POST', body: { profileId: 'synthetic-a' } });
  assert.match(host.innerHTML, /Proposer une plante/);
});

test('switching child while loading never shows the previous child\'s proposal', async () => {
  const host = fakeHost();
  let current = child, release;
  const slow = new Promise(resolve => { release = () => resolve({ rooms, proposal: waiting }); });
  const { api } = fakeApi([() => slow, { rooms, proposal: null }]);
  const controller = mount({ host, api, esc, profile: () => current });
  current = { id: 'synthetic-b', displayName: 'Synthetic B' };
  await controller.refresh();
  release();
  await settle();
  assert.equal(controller.model.proposal, null);
  assert.match(host.innerHTML, /Proposer une plante/);
});

test('a guest sees no proposal request at all', async () => {
  const host = fakeHost();
  const { api, calls } = fakeApi([]);
  mount({ host, api, esc, profile: () => null });
  await settle();
  assert.equal(calls.length, 0);
  assert.match(host.innerHTML, /Choisis ton nom/);
});

test('the photo is reduced to a display rendition before it is read', async () => {
  const images = { isImage: () => true, accepts: () => true, reduce: async file => ({ reduced: file }) };
  assert.equal(await photoDataUrl({ name: 'synthetic.jpg' }, images, async reduced => `read:${reduced.reduced.name}`), 'read:synthetic.jpg');
  await assert.rejects(photoDataUrl({ name: 'x.txt' }, { ...images, isImage: () => false }), { code: 'PLANT_PHOTO_INVALID' });
});

test('the parent list puts the child\'s name on a proposal, and its banner offers a kind reply', () => {
  const profiles = [{ id: 'synthetic-a', displayName: 'Synthetic A' }];
  const proposed = { id: 'p1', status: 'draft', nickname: 'Plante de Synthetic A', room: 'Salon', photos: [], problems: ['species'],
    proposal: { proposedBy: 'synthetic-a', state: 'pending', open: true } };
  const row = view.listRowHtml(proposed, esc, profiles);
  assert.match(row, /class="plant-row status-draft proposed"/); assert.match(row, /Proposée par Synthetic A/); assert.match(row, /Salon · Choose the species/);
  const banner = view.proposalBannerHtml(proposed, esc, profiles);
  assert.match(banner, /Proposée par Synthetic A/); assert.match(banner, /data-plant-decline/);
  assert.match(banner, /<option>Papa a vu ta plante\. Merci !<\/option>/);
  assert.equal(view.proposalBannerHtml({ ...proposed, proposal: { ...proposed.proposal, state: 'declined', open: false } }, esc, profiles), '');
  assert.doesNotMatch(view.listRowHtml({ ...proposed, proposal: null }, esc, profiles), /Proposée/);
  // An unknown profile still names the proposer by its id rather than hiding it.
  assert.match(view.listRowHtml(proposed, esc, []), /Proposée par synthetic-a/);
});
