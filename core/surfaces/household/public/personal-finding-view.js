/* Read-only presentation. Shared source links never prove duplicate actions,
   an actor, a current obligation or resolution. Original wording is retained. */
(function (root) {
  const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  function mailSource(value) {
    try {
      const url = new URL(String(value || '').replace(/[.,;]+$/, ''));
      if (url.protocol !== 'https:' || url.hostname !== 'mail.google.com') return null;
      const thread = url.hash.match(/^#(?:all|inbox|sent|search\/[^/]+)\/([a-zA-Z0-9_-]+)$/);
      return { href: url.href, key: thread ? `mail:${thread[1]}` : url.href };
    } catch (_) { return null; }
  }
  function displayTitle(task) {
    // Remove explicit extraction metadata, never conditions such as "if unpaid".
    return String(task.title || '').replace(/\(historique\)\s*/gi, '')
      .replace(/\s*\((?:demande de |demande du |engagement de |message du |fil |offset |historique[, ]|source[ :])[^()]*\)\s*$/i, '')
      .replace(/\s*[—–]\s*(?:demande|message|courriel) (?:du|de) .{0,100}$/i, '')
      .replace(/\s+/g, ' ').trim() || String(task.title || 'Untitled finding');
  }
  function contextExcerpt(task) {
    const text = String(task.note || '').replace(/^Secretary deep review\s*\/\s*action\s+\S+\.\s*/i, '')
      .replace(/https:\/\/mail\.google\.com\/[^\s]+/g, '')
      .replace(/\b(?:message|fil|thread)\s+[a-f0-9]{12,}\b/gi, '')
      .replace(/\bURL\s*(?=[,.;)])/g, '')
      .replace(/\b[a-f0-9]{16,64}\b/gi, '[reference]')
      .replace(/\b(?:pageId|sha256)\s*[: ]\s*[a-f0-9]{24,}\b/gi, '[reference]')
      .replace(/\s+/g, ' ').trim();
    return text.length > 460 ? `${text.slice(0, 457)}…` : text;
  }
  function sourceSubject(task) {
    const note = String(task.note || '');
    const quoted = note.match(/(?:objet|subject)\s*[: ]\s*[«“"]([^»”"]{3,120})[»”"]/i);
    if (quoted) return quoted[1].trim();
    const named = note.match(/\bfil\s+([A-Za-zÀ-ÿ][^,().]{2,100}?)(?=\s+[a-f0-9]{12,})/i);
    return named ? named[1].trim() : null;
  }
  function flags(task, now = new Date()) {
    return { pastDate: Boolean(task.dueAt && Number.isFinite(Date.parse(task.dueAt)) && Date.parse(task.dueAt) < +now), missingSource: !mailSource(task.sourceUrl) };
  }
  function groupFindings(tasks = [], { category = 'email', query = '', quality = '', now = new Date() } = {}) {
    const words = fold(query).trim().split(/\s+/).filter(Boolean), groups = new Map();
    for (const task of tasks) {
      if (category === 'background' ? !['platform', 'assistant'].includes(task.category) : category && task.category !== category) continue;
      const f = flags(task, now);
      if (quality === 'past-date' && !f.pastDate || quality === 'missing-source' && !f.missingSource) continue;
      const haystack = fold(`${task.title} ${task.note} ${task.id}`);
      if (!words.every(word => haystack.includes(word))) continue;
      const source = mailSource(task.sourceUrl), key = source?.key || `task:${task.id}`;
      if (!groups.has(key)) groups.set(key, { key, sourceUrl: source?.href || null, tasks: [], latestAt: null });
      const group = groups.get(key);
      group.tasks.push(task);
      if (task.createdAt && (!group.latestAt || Date.parse(task.createdAt) > Date.parse(group.latestAt))) group.latestAt = task.createdAt;
    }
    for (const group of groups.values()) {
      group.tasks.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || String(b.id).localeCompare(String(a.id)));
      group.title = group.tasks.map(sourceSubject).find(Boolean) || displayTitle(group.tasks[0]);
      group.preview = displayTitle(group.tasks[0]);
      group.pastDates = group.tasks.filter(task => flags(task, now).pastDate).length;
    }
    return [...groups.values()].sort((a, b) => (Date.parse(b.latestAt) || 0) - (Date.parse(a.latestAt) || 0) || a.key.localeCompare(b.key));
  }
  const view = { fold, mailSource, displayTitle, contextExcerpt, sourceSubject, flags, groupFindings };
  if (typeof module !== 'undefined') module.exports = view;
  else root.HouseholdPersonalFindingView = view;
}(typeof window !== 'undefined' ? window : globalThis));
