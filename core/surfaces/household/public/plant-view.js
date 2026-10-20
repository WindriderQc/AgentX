/* Household plants, parent page (#868): pure rendering helpers. The page module
   (plants-parent.js) owns the DOM, requests and polling; this file only turns a
   managed plant card into HTML and reads the editor back into Core's fields. */
(function () {
  'use strict';
  const CARE = [['light', 'Light'], ['water', 'Watering'], ['humidity', 'Humidity'], ['soil', 'Soil'],
    ['repotting', 'Repotting'], ['fertilizer', 'Fertilizer'], ['mistakes', 'Common mistakes']];
  const TOXICITY = [['children', 'Children'], ['cats', 'Cats'], ['dogs', 'Dogs']];
  const LEVELS = [['unknown', 'Not set'], ['none', 'Not toxic'], ['mild', 'Mildly toxic'], ['toxic', 'Toxic']];
  const BANDS = [['little', 'Little ones'], ['school', 'School age'], ['teen', 'Teens']];
  const BAND_RANK = { little: 0, school: 1, teen: 2 };
  const ROOMS = ['Salon', 'Cuisine', 'Chambre', 'Salle de bain', 'Bureau', 'Sous-sol'];
  const PROBLEMS = {
    species: 'Choose the species.',
    toxicity: 'Set the toxicity for children, cats and dogs.',
    toxicity_review: 'Confirm that you checked the toxicity.',
    care_plan: 'Add at least one care action.'
  };

  const problemText = problems => (problems || []).map(code => PROBLEMS[code] || code);
  const statusLabel = status => ({ draft: 'Draft', published: 'Published', retired: 'Retired' })[status] || 'Draft';
  const percent = value => Number.isFinite(value) ? `${Math.round(value * 100)} %` : '—';
  const options = (pairs, selected) => pairs.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');
  const sourceCount = sources => sources?.length ? `${sources.length} source${sources.length > 1 ? 's' : ''}` : 'no source';

  /** A child may get an action only from its minimum age band up. */
  function ageAllows(profile, action) {
    return BAND_RANK[profile?.ageBand] >= BAND_RANK[action?.minAgeBand || 'school'];
  }

  function candidatesHtml(candidates, esc, chosen = null) {
    if (!candidates?.length) return '<p class="muted">Nestor found no plant in this photo. Try a closer photo of a leaf, or type the species.</p>';
    return `<div class="plant-candidates" role="radiogroup" aria-label="Proposed species">${candidates.map((candidate, index) => {
      const checked = chosen ? candidate.commonName === chosen : index === 0;
      const strong = (candidate.confidence ?? 0) >= 0.7;
      return `<label class="plant-candidate${checked ? ' selected' : ''}"><input type="radio" name="plantCandidate" value="${index}"${checked ? ' checked' : ''}>
        <span class="plant-candidate-head"><strong>${esc(candidate.commonName)}</strong><span>${esc(percent(candidate.confidence))}</span></span>
        ${candidate.latinName ? `<em>${esc(candidate.latinName)}</em>` : ''}
        <span class="plant-confidence" aria-hidden="true"><span class="${strong ? 'strong' : 'weak'}" style="width:${Math.max(4, Math.round((candidate.confidence ?? 0) * 100))}%"></span></span>
        ${candidate.traits ? `<small>${esc(candidate.traits)}</small>` : ''}</label>`;
    }).join('')}</div>${(candidates[0].confidence ?? 0) < 0.5 ? '<p class="plant-note">Nestor is not sure. A close-up of one leaf usually helps.</p>' : ''}`;
  }

  // The three needs the children see come first; the rest folds away on a phone.
  function careSheetHtml(sheet, esc) {
    const field = ([key, label]) => `<label class="plant-field"><span>${label}</span>
      <textarea name="care-${key}" rows="2" maxlength="500">${esc(sheet?.[key]?.text || '')}</textarea>
      <small class="muted" data-sources="${key}">${esc(sourceCount(sheet?.[key]?.sources))}</small></label>`;
    const more = CARE.slice(3), filled = more.filter(([key]) => sheet?.[key]?.text).length;
    return `${CARE.slice(0, 3).map(field).join('')}<details class="family-disclosure plant-more">
      <summary>More care details${filled ? ` (${filled})` : ''}</summary><div class="plant-more-fields">${more.map(field).join('')}</div></details>`;
  }

  function toxicityHtml(toxicity, esc) {
    return `<div class="plant-toxicity-grid">${TOXICITY.map(([key, label]) => `<label class="plant-field"><span>${label}</span>
      <select name="tox-${key}">${options(LEVELS, toxicity?.[key]?.level || 'unknown')}</select>
      ${toxicity?.[key]?.note ? `<small>${esc(toxicity[key].note)}</small>` : ''}</label>`).join('')}</div>
      <label class="plant-check"><input type="checkbox" name="tox-reviewed"${toxicity?.reviewed ? ' checked' : ''}>
      I checked this. Children will see “Do not eat” when a level is mild or toxic.</label>`;
  }

  function actionHtml(action, index, profiles, esc, frequency) {
    const assignable = profiles.filter(profile => ageAllows(profile, action));
    return `<fieldset class="plant-action" data-action="${index}"><legend>Care action ${index + 1}</legend>
      <label class="plant-field wide"><span>Task</span><input name="title" maxlength="160" value="${esc(action.title || '')}" required></label>
      <label class="plant-field wide"><span>How (optional)</span><input name="note" maxlength="1000" value="${esc(action.note || '')}"></label>
      <label class="plant-field"><span>Frequency</span><select name="cadence">${frequency.options(action.cadence || 'weekly')}</select></label>
      ${frequency.fields()}
      <label class="plant-field"><span>Stars</span><select name="stars">${options([1, 2, 3, 4, 5].map(value => [String(value), '★'.repeat(value)]), String(action.stars || 1))}</select></label>
      <label class="plant-field"><span>From</span><select name="minAgeBand">${options(BANDS, action.minAgeBand || 'school')}</select></label>
      <label class="plant-field"><span>For</span><select name="profileId"><option value="">Not assigned yet</option>${assignable.map(profile =>
        `<option value="${esc(profile.id)}"${profile.id === action.profileId ? ' selected' : ''}>${esc(profile.displayName)}</option>`).join('')}</select></label>
      <button type="button" class="compact danger" data-remove-action="${index}">Remove</button></fieldset>`;
  }

  /** What the published card shows a child, so the parent sees it before publishing. */
  function childPreviewHtml(plant, esc) {
    const levels = ['children', 'cats', 'dogs'].map(key => plant.toxicity?.[key]?.level);
    const doNotEat = levels.some(level => ['mild', 'toxic'].includes(level));
    const needs = CARE.slice(0, 3).filter(([key]) => plant.careSheet?.[key]?.text);
    return `<div class="plant-child-preview"><p class="card-kicker">What the kids will see</p>
      <strong>${esc(plant.nickname)}</strong><small>${esc(plant.identification?.commonName || 'Species not chosen')}</small>
      ${needs.map(([key, label]) => `<p><span>${label}</span>${esc(plant.careSheet[key].text)}</p>`).join('')}
      ${doNotEat ? '<p class="plant-do-not-eat">Do not eat — not for the pets either.</p>' : ''}
      ${plant.funFact ? `<p><span>Did you know?</span>${esc(plant.funFact)}</p>` : ''}</div>`;
  }

  const MOODS = { thirsty: ['Thirsty', 'down'], needs_care: ['Needs care', 'waiting'], waiting: ['Check-in to approve', 'waiting'], happy: ['Happy', 'ok'] };

  /** The next care chore of a published plant, in words: "Arroser · today · Léo". */
  function nextCare(plant, profiles = []) {
    const next = [...(plant.care || [])].sort((a, b) => Number(b.overdue) - Number(a.overdue) || String(a.dueDay || '9').localeCompare(String(b.dueDay || '9')))[0];
    if (!next) return plant.carePlan?.some(action => action.profileId) ? '' : 'No child assigned yet';
    const who = profiles.find(profile => profile.id === next.profileId)?.displayName || next.profileId;
    const when = next.waiting ? 'to approve' : next.overdue ? 'overdue' : next.dueToday ? 'today' : next.dueDay || '';
    return [next.title, when, who].filter(Boolean).join(' · ');
  }

  /** One line for the parent after a save: what changed in the Kids Room. */
  function choreSummary(result) {
    if (!result) return '';
    const parts = [];
    const count = (list, verb) => list?.length && parts.push(`${list.length} chore${list.length > 1 ? 's' : ''} ${verb}`);
    count(result.created, 'created'); count(result.updated, 'updated'); count(result.cancelled, 'cancelled');
    if (result.waiting?.length) parts.push(`${result.waiting.length} waiting for your approval, unchanged`);
    if (result.errors?.length) parts.push(`${result.errors.length} not updated, save again`);
    return parts.length ? `Kids Room: ${parts.join(', ')}.` : '';
  }

  function listRowHtml(plant, esc, profiles = []) {
    const photo = plant.photos?.[0];
    const hint = plant.status === 'draft' ? (problemText(plant.problems)[0] || 'Ready to publish.') : nextCare(plant, profiles) || plant.room || '';
    const [moodLabel, moodClass] = plant.status === 'published' ? MOODS[plant.mood] || MOODS.happy : [statusLabel(plant.status), plant.status === 'draft' ? 'waiting' : ''];
    return `<a class="plant-row status-${esc(plant.status)}" href="/dad/family/plants?plant=${encodeURIComponent(plant.id)}">
      ${photo ? `<img src="${esc(photo.url)}?view=manage" alt="" loading="lazy">` : '<span class="plant-thumb" aria-hidden="true"></span>'}
      <span class="grow"><strong>${esc(plant.nickname)}</strong><small>${esc(plant.identification?.commonName || 'Species to choose')}${hint ? ` · ${esc(hint)}` : ''}</small></span>
      <span class="pill ${moodClass}">${moodLabel}</span></a>`;
  }

  /** Reads the editor back into Core's plant fields. */
  function readEditor(form, frequency) {
    const value = name => form.querySelector(`[name="${name}"]`)?.value ?? '';
    const careSheet = Object.fromEntries(CARE.map(([key]) => [key, { text: value(`care-${key}`) }]).filter(([, entry]) => entry.text.trim()));
    const toxicity = Object.fromEntries(TOXICITY.map(([key]) => [key, { level: value(`tox-${key}`) || 'unknown' }]));
    toxicity.reviewed = Boolean(form.querySelector('[name="tox-reviewed"]')?.checked);
    const carePlan = [...form.querySelectorAll('[data-action]')].map(fieldset => {
      const field = name => fieldset.querySelector(`[name="${name}"]`).value;
      const cadence = field('cadence');
      return { title: field('title'), note: field('note'), cadence, stars: Number(field('stars')), minAgeBand: field('minAgeBand'),
        profileId: field('profileId') || null, ...frequency.read(fieldset, cadence) };
    }).filter(action => action.title.trim());
    return { nickname: value('nickname'), room: value('room'), spot: value('spot'), funFact: value('funFact'), careSheet, toxicity, carePlan };
  }

  /** Keeps the sources a field already had when its text is unchanged. */
  function keepSources(fields, plant) {
    for (const [key, entry] of Object.entries(fields.careSheet)) {
      const before = plant.careSheet?.[key];
      if (before && before.text === entry.text) entry.sources = before.sources || [];
    }
    for (const key of ['children', 'cats', 'dogs']) {
      const before = plant.toxicity?.[key];
      if (before && before.level === fields.toxicity[key].level) Object.assign(fields.toxicity[key], { note: before.note, sources: before.sources || [] });
    }
    return fields;
  }

  /** True when the card already carries this draft's care text and actions. */
  function draftApplied(draft, plant) {
    const sameSheet = Object.entries(draft?.careSheet || {}).every(([key, entry]) => plant.careSheet?.[key]?.text === entry.text);
    const titles = list => (list || []).map(action => action.title).join('\n');
    return Boolean(draft) && sameSheet && titles(draft.carePlan) === titles(plant.carePlan);
  }

  window.PlantView = { CARE, ROOMS, ageAllows, choreSummary, draftApplied, nextCare, actionHtml, candidatesHtml, careSheetHtml, childPreviewHtml, keepSources,
    listRowHtml, problemText, readEditor, statusLabel, toxicityHtml };
})();
