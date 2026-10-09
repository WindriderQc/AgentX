'use strict';

// The Toolbox Files tab (read-only). Loaded before app.js, whose helpers
// (state, api, e, array, number, bytes, percent, date, heading, metric…) it
// uses when called. Four views of what the storage scans recorded: the file
// list with its filters, the folders, the duplicate groups and the cleanup
// suggestions. Every request is a GET: nothing here changes a file.
// Names and paths come from the disks: they are always escaped.

const FILES_VIEWS = Object.freeze({ list: 'Files', folders: 'Folders', duplicates: 'Duplicates', cleanup: 'Cleanup' });
// The category names Data classifies files into (data/utils/categories.js).
const FILE_CATEGORIES = ['document', 'media', 'archive', 'code', 'config', 'playlist', 'checksum', 'media_project', 'log', 'firmware', 'resource', 'certificate', 'backup', 'shortcut', 'engineering', 'model', 'disk_image', 'three_d', 'binary', 'data', 'database', 'game', 'font', 'localization', 'repository', 'cache', 'unclassified'];
const FILE_SORTS = Object.freeze({ mtime: 'Modified', filename: 'Name', size: 'Size' });
const FILE_SIZE_UNITS = Object.freeze({ KiB: 1024, MiB: 1048576, GiB: 1073741824 });
const FILE_PAGE_SIZES = Object.freeze(['25', '50', '100']);
const FILES_EXTENSIONS_LISTED = 25; // Data lists the 25 largest extensions
const FILES_TREE_LIMIT = 2000; // Data's ceiling for one folder read
const FILES_DUPLICATES_LIMIT = 100;
const FILES_DUPLICATES_PAGE = 10;
const FILES_PATHS_SHOWN = 20;
const FILES_CACHE_MS = 60000;
const FILES_CLEANUP_TITLES = Object.freeze({
  large_files_review: 'Large files', old_files_review: 'Old files', verified_duplicates: 'Verified duplicates',
  duplicate_candidates: 'Duplicate candidates', zero_byte_files: 'Empty files', root_clutter: 'Files directly at the root'
});

const filesTools = {
  view: 'list', seq: 0, stats: null, directories: null, statsAt: 0, statsPending: null,
  folder: '', scope: '', duplicates: null, duplicatesPage: 1
};

const filesSettled = (promise) => promise.then((data) => ({ data }), (error) => ({ error: error.message }));
const filesStale = (token) => token !== filesTools.seq || state.tab !== 'files';
const filesLoading = (text) => `<div class="loading"><span></span>${e(text)}</div>`;
const filesSize = (value) => Number.isFinite(measurement(value)) ? bytes(value) : (typeof value === 'string' && value ? e(value) : '—');
const filesGo = (params) => files(params).catch(errorView);

// ---------------------------------------------------------------- page frame

function filesStatsSection() {
  const stats = filesTools.stats;
  const directories = filesTools.directories;
  if (stats?.error) return `<div class="notice warning">The index totals could not be read from Data: ${e(stats.error)}. The views below do not depend on them.</div>`;
  const pending = !stats;
  const total = stats?.data?.total;
  const extensions = array(stats?.data?.byExtension);
  const capped = extensions.length >= FILES_EXTENSIONS_LISTED;
  return `<div class="grid">
    ${metric(pending ? '…' : number(total?.count), 'files in the index')}
    ${metric(pending ? '…' : bytes(total?.totalSize), 'total size')}
    ${metric(pending ? '…' : capped ? `${FILES_EXTENSIONS_LISTED}+` : number(extensions.length), capped ? `extensions (Data lists the ${FILES_EXTENSIONS_LISTED} largest)` : 'extensions')}
    ${metric(pending || !directories ? '…' : number(directories.data?.count), 'folders holding files')}
  </div>
  <datalist id="fileExtensions">${extensions.map((item) => item.extension && item.extension !== 'no extension' ? `<option value="${e(item.extension)}"></option>` : '').join('')}</datalist>`;
}

// The header totals are read beside the view, never before it: a slow or
// failed total does not hold the list back.
function filesLoadStats(force = false) {
  if (!force && (filesTools.statsPending || Date.now() - filesTools.statsAt < FILES_CACHE_MS)) return filesTools.statsPending;
  filesTools.statsAt = Date.now();
  filesTools.statsPending = Promise.all([filesSettled(api('/storage/stats')), filesSettled(api('/storage/directory-count'))]).then(([stats, directories]) => {
    Object.assign(filesTools, { stats, directories, statsPending: null });
    const target = document.querySelector('#filesStats');
    if (target && state.tab === 'files') target.innerHTML = filesStatsSection();
  });
  return filesTools.statsPending;
}

function filesPaint(body) {
  content.innerHTML = `${heading('File inventory', 'What the storage scans recorded: files, folders, duplicate groups and cleanup suggestions.', '<button type="button" class="button" data-files-action="refresh">Refresh</button>')}
    <section id="filesStats">${filesStatsSection()}</section>
    <div class="notice" role="note"><strong>Read-only.</strong> Nothing is deleted, moved or renamed from this page. Paths and metadata can be private: they stay on the local AgentX origin.</div>
    <nav class="view-switch" aria-label="File inventory views">${Object.entries(FILES_VIEWS).map(([view, title]) => `<button type="button" class="button ${filesTools.view === view ? 'active' : ''}" data-files-view="${view}" aria-pressed="${filesTools.view === view}">${e(title)}</button>`).join('')}</nav>
    ${body}`;
}

// The tab's entry point. With `params` (the filter form) it shows the list.
async function files(params) {
  if (params) {
    state.filesQuery = params.toString();
    filesTools.view = 'list';
  }
  const token = ++filesTools.seq;
  filesLoadStats();
  const views = { list: filesList, folders: filesFolders, duplicates: filesDuplicates, cleanup: filesCleanup };
  await (views[filesTools.view] || filesList)(token);
}

// ---------------------------------------------------------------- file list

function fileToolbar() {
  const options = (values) => Object.entries(values).map(([value, title]) => `<option value="${e(value)}">${e(title)}</option>`).join('');
  return `<form id="fileFilters" class="file-filters">
    <label>Filename contains<input name="search" autocomplete="off"></label>
    <label>Folder<input name="root" class="mono" placeholder="/mnt/…" autocomplete="off" spellcheck="false"></label>
    <label>Category<select name="category"><option value="">All categories</option>${FILE_CATEGORIES.map((category) => `<option>${e(category)}</option>`).join('')}</select></label>
    <label>Extension<input name="ext" list="fileExtensions" placeholder="pdf" autocomplete="off" spellcheck="false"></label>
    <label>Min size<input name="minSize" type="number" min="0" step="any" inputmode="decimal"></label>
    <label>Max size<input name="maxSize" type="number" min="0" step="any" inputmode="decimal"></label>
    <label>Size unit<select name="sizeUnit">${Object.keys(FILE_SIZE_UNITS).map((unit) => `<option${unit === 'MiB' ? ' selected' : ''}>${unit}</option>`).join('')}</select></label>
    <label>Hash<select name="hasHash">${options({ '': 'Any', true: 'Has a hash', false: 'No hash' })}</select></label>
    <label>Sort by<select name="sortBy">${options(FILE_SORTS)}</select></label>
    <label>Order<select name="sortOrder">${options({ desc: 'Descending', asc: 'Ascending' })}</select></label>
    <label>Page size<select name="limit">${FILE_PAGE_SIZES.map((size) => `<option${size === '50' ? ' selected' : ''}>${size}</option>`).join('')}</select></label>
    <div class="file-filters-actions"><button class="button" type="submit">Apply filters</button><button type="button" class="button" data-files-action="reset">Reset</button></div>
  </form>
  <p class="muted files-help">Folder keeps the files in that folder and below. An extension takes precedence over the category. Sizes use the unit chosen.</p>`;
}

function restoreFileFilters(params) {
  const form = document.querySelector('#fileFilters');
  for (const [key, value] of params) if (form?.elements?.[key] && key !== 'page') form.elements[key].value = value;
}

// What the form holds becomes Data's query: sizes in bytes, a bounded page size.
function fileQuery(params) {
  const query = new URLSearchParams();
  for (const key of ['search', 'root', 'category', 'ext', 'hasHash', 'sortBy', 'sortOrder']) {
    const value = (params.get(key) || '').trim();
    if (value) query.set(key, value);
  }
  const unit = FILE_SIZE_UNITS[params.get('sizeUnit')] || FILE_SIZE_UNITS.MiB;
  const sizes = {};
  for (const key of ['minSize', 'maxSize']) {
    const raw = (params.get(key) || '').trim();
    if (!raw) continue;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0) return { problem: `${key === 'minSize' ? 'Min' : 'Max'} size must be a number, zero or more.` };
    sizes[key] = Math.min(Number.MAX_SAFE_INTEGER, Math.round(amount * unit));
    query.set(key, String(sizes[key]));
  }
  if (sizes.minSize > sizes.maxSize) return { problem: 'Min size is larger than max size.' };
  query.set('limit', FILE_PAGE_SIZES.includes(params.get('limit')) ? params.get('limit') : '50');
  query.set('page', String(state.filesPage));
  return { query };
}

function fileRow(file) {
  const modified = file.mtimeFormatted || (Number.isFinite(measurement(file.mtime)) ? file.mtime * 1000 : null);
  return `<tr><td>${e(file.filename || file.name || '—')}</td>
    <td class="mono muted">${e(file.dirname || file.path || '—')}</td>
    <td>${filesSize(file.size ?? file.sizeFormatted)}</td>
    <td><span class="pill">${e(file.category || file.ext || 'unclassified')}</span></td>
    <td>${date(modified)}</td>
    <td class="mono">${file.sha256 ? `${e(String(file.sha256).slice(0, 12))}…` : '<span class="warn">missing</span>'}</td></tr>`;
}

async function filesList(token) {
  const params = new URLSearchParams(state.filesQuery);
  const { query, problem } = fileQuery(params);
  const result = problem ? { error: problem } : await filesSettled(api(`/storage/files?${query}`));
  if (filesStale(token)) return;
  if (result.error) {
    // Keep the filter form so a refused query can be corrected in place.
    filesPaint(`${fileToolbar()}<div class="notice warning">These filters could not be applied: ${e(result.error)}</div>`);
    restoreFileFilters(params);
    return;
  }
  const rows = array(result.data.files);
  const paging = result.data.pagination || {};
  filesPaint(`${fileToolbar()}
    <div class="table-wrap" tabindex="0" role="region" aria-label="File inventory table"><table class="file-inventory-table"><thead><tr><th scope="col">Name</th><th scope="col">Folder</th><th scope="col">Size</th><th scope="col">Category</th><th scope="col">Modified</th><th scope="col">Hash</th></tr></thead><tbody>
      ${rows.length ? rows.map(fileRow).join('') : noRows(6, 'No file matches these filters.')}
    </tbody></table></div>
    <p class="muted">Page ${number(paging.page || 1)} of ${number(paging.pages || 1)} · ${number(paging.total ?? rows.length)} matching files</p>
    <nav class="pager" aria-label="File inventory pages">
      <button type="button" class="button" data-action="files-previous" ${state.filesPage <= 1 ? 'disabled' : ''}>Previous page</button>
      <button type="button" class="button" data-action="files-next" ${state.filesPage >= (paging.pages || 1) ? 'disabled' : ''}>Next page</button>
    </nav>`);
  restoreFileFilters(params);
}

// ------------------------------------------------------------------ folders

// Data records one row per folder that holds files directly, with the count
// and size of those files only, and answers the largest rows under a path.
// The rows are grouped here by the next folder name. When Data cut its answer
// the sums are a lower bound and say so.
function filesFolderModel(folder, rows) {
  const listed = array(rows).filter((row) => typeof row?.path === 'string' && row.path.startsWith('/'));
  let base = String(folder || '').replace(/\/+$/, '');
  if (!folder) {
    // No folder chosen: start where the recorded folders have a common parent.
    let common = null;
    for (const row of listed) {
      const parent = row.path.split('/').slice(1, -1);
      if (common === null) common = parent;
      else common = common.slice(0, common.findIndex((name, index) => parent[index] !== name) >>> 0);
    }
    base = common?.length ? `/${common.join('/')}` : '';
  }
  const children = new Map();
  let own = null;
  for (const row of listed) {
    if (row.path === base) { own = row; continue; }
    if (!row.path.startsWith(`${base}/`)) continue;
    const name = row.path.slice(base.length + 1).split('/')[0];
    if (!name) continue;
    const child = children.get(name) || { name, path: `${base}/${name}`, files: 0, size: 0, folders: 0 };
    child.files += Number.isFinite(measurement(row.fileCount)) ? Number(row.fileCount) : 0;
    child.size += Number.isFinite(measurement(row.totalSize)) ? Number(row.totalSize) : 0;
    child.folders += 1;
    children.set(name, child);
  }
  return { base, own, children: [...children.values()].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name)) };
}

function filesCrumbs(base) {
  const names = base.split('/').filter(Boolean);
  const crumbs = names.map((name, index) => {
    const path = `/${names.slice(0, index + 1).join('/')}`;
    return index === names.length - 1
      ? `<span class="mono" aria-current="location">${e(name)}</span>`
      : `<button type="button" class="link-button mono" data-files-folder="${e(path)}">${e(name)}</button>`;
  });
  return `<nav class="crumbs" aria-label="Folder path"><button type="button" class="link-button" data-files-folder="">All folders</button>${crumbs.map((crumb) => `<span aria-hidden="true">/</span>${crumb}`).join('')}</nav>`;
}

function filesFoldersSection(folder, tree, totals) {
  if (tree.error) return `${filesCrumbs(folder)}<div class="notice warning">The folders could not be read from Data: ${e(tree.error)}.</div>`;
  const cut = tree.data?.truncated === true;
  const { base, own, children } = filesFolderModel(folder, tree.data?.tree);
  const least = cut ? '≥ ' : '';
  const total = totals?.data?.total;
  const below = totals?.error ? `<span class="warn">could not be read: ${e(totals.error)}</span>`
    : total ? `${number(total.count)} files · ${bytes(total.totalSize)}` : '—';
  const direct = own ? `${number(own.fileCount)} files · ${bytes(own.totalSize)}` : cut ? 'not in the rows Data returned' : 'none';
  return `${filesCrumbs(base)}
    <article class="card folder-here">
      <div class="card-title"><h3 class="mono">${e(base || '/')}</h3>${base ? `<button type="button" class="button" data-files-show="${e(base)}">Show files here</button>` : ''}</div>
      <div class="metric-row"><span>This folder and everything below</span><strong>${below}</strong></div>
      <div class="metric-row"><span>Files directly in this folder</span><strong>${direct}</strong></div>
    </article>
    ${cut ? `<div class="notice warning">Data returned the ${number(tree.data.limit ?? FILES_TREE_LIMIT)} largest folders under this one, not all of them. Counts and sizes marked ≥ are at least that much, and small folders may be missing from the list. Open a folder for exact figures.</div>` : ''}
    <div class="table-wrap" tabindex="0" role="region" aria-label="Folders"><table class="folder-table"><thead><tr><th scope="col">Folder</th><th scope="col">Files below</th><th scope="col">Size below</th><th scope="col">Folders holding files</th><th scope="col">Files</th></tr></thead><tbody>
      ${children.length ? children.map((child) => `<tr>
        <td><button type="button" class="link-button mono" data-files-folder="${e(child.path)}">${e(child.name)}</button></td>
        <td>${least}${number(child.files)}</td><td>${least}${bytes(child.size)}</td><td>${least}${number(child.folders)}</td>
        <td><button type="button" class="button" data-files-show="${e(child.path)}">Show files</button></td></tr>`).join('')
    : noRows(5, own || !cut ? 'No folder below this one holds recorded files.' : 'No folder recorded here.')}
    </tbody></table></div>`;
}

async function filesFolders(token) {
  const folder = filesTools.folder;
  filesPaint(`${filesCrumbs(folder)}${filesLoading('Reading the folders…')}`);
  const [tree, totals] = await Promise.all([
    filesSettled(api(`/storage/tree?${new URLSearchParams({ root: folder || '/', limit: String(FILES_TREE_LIMIT) })}`)),
    folder ? filesSettled(api(`/storage/stats?${new URLSearchParams({ root: folder })}`)) : (filesLoadStats() || Promise.resolve()).then(() => filesTools.stats)
  ]);
  if (filesStale(token)) return;
  filesPaint(filesFoldersSection(folder, tree, totals));
}

// ------------------------------------------------- duplicates and cleanup

function filesScopeForm(what) {
  return `<form id="filesScope" class="file-filters">
    <label>Folder (optional)<input name="root" class="mono" value="${e(filesTools.scope)}" placeholder="/mnt/…" autocomplete="off" spellcheck="false"></label>
    <div class="file-filters-actions"><button class="button" type="submit">Apply</button>${filesTools.scope ? '<button type="button" class="button" data-files-action="scope-clear">Whole index</button>' : ''}</div>
  </form>
  <p class="muted files-help">${e(`${what} ${filesTools.scope ? `Limited to ${filesTools.scope} and below.` : 'Across the whole index.'}`)}</p>`;
}

function filesPathList(items, extra = () => '') {
  const shown = items.slice(0, FILES_PATHS_SHOWN);
  return `<ul class="path-list">${shown.map((item) => `<li><span class="mono">${e(item.path || [item.dirname, item.filename].filter(Boolean).join('/') || '—')}</span>${extra(item)}</li>`).join('')}
    ${items.length > shown.length ? `<li class="muted">and ${number(items.length - shown.length)} more not listed here</li>` : ''}</ul>`;
}

function filesDuplicateGroup(group, verified) {
  const places = array(group.locations).map((place) => ({ ...place, filename: place.filename || group.filename }));
  return `<article class="card dup-group">
    <div class="card-title"><h3>${number(group.count)} copies · ${bytes(group.size)} each</h3><span class="pill warn">${bytes(group.wastedSpace)} reclaimable</span></div>
    <p class="muted mono">${verified && group.sha256 ? `sha256 ${e(String(group.sha256).slice(0, 16))}…` : `same name and size, not verified: ${e(group.filename || '—')}`}</p>
    ${filesPathList(places, (place) => ` <span class="muted">modified ${date(Number.isFinite(measurement(place.mtime)) ? place.mtime * 1000 : null)}</span>`)}
  </article>`;
}

function filesDuplicatesSection() {
  const { groups: read, summary } = filesTools.duplicates;
  const form = filesScopeForm('Groups of files with the same content.');
  if (read.error) return `${form}<div class="notice warning">The duplicate groups could not be read from Data: ${e(read.error)}.</div>`;
  const data = read.data || {};
  const groups = array(data.duplicates);
  const verified = data.verified === true;
  const index = summary?.data?.duplicates;
  const pages = Math.max(1, Math.ceil(groups.length / FILES_DUPLICATES_PAGE));
  const page = Math.min(pages, Math.max(1, filesTools.duplicatesPage));
  const first = (page - 1) * FILES_DUPLICATES_PAGE;
  const shown = groups.slice(first, first + FILES_DUPLICATES_PAGE);
  return `${form}
    <div class="grid">
      ${metric(summary?.error ? '—' : number(index?.groups), 'verified duplicate groups in the index')}
      ${metric(summary?.error ? '—' : bytes(index?.potentialSavings), 'reclaimable if one copy of each is kept')}
      ${metric(percent(data.coverage?.fileRatio), 'of the files are hashed')}
      ${metric(percent(data.coverage?.byteRatio), 'of the bytes are hashed')}
    </div>
    ${summary?.error ? `<div class="notice warning">The index totals could not be read from Data: ${e(summary.error)}. The groups below do not depend on them.</div>` : ''}
    <div class="notice ${verified ? '' : 'warning'}">${verified
    ? 'Two files are listed together when their SHA-256 hashes are equal. Files not hashed yet cannot be compared, so these figures are a lower bound.'
    : `<strong>Not verified.</strong> ${e(data.note || 'These groups share a name and a size only; their content was not compared.')}`}
      Nothing is deleted from this page: choosing which copy to keep is a review, done in the Janitor tab.</div>
    ${groups.length ? `<p class="muted">Groups ${number(first + 1)}–${number(first + shown.length)} of the ${number(groups.length)} largest. Data returns the largest groups only, at most ${FILES_DUPLICATES_LIMIT} here.</p>
      <div class="dup-list">${shown.map((group) => filesDuplicateGroup(group, verified)).join('')}</div>
      <nav class="pager" aria-label="Duplicate group pages">
        <button type="button" class="button" data-files-action="duplicates-previous" ${page <= 1 ? 'disabled' : ''}>Previous groups</button>
        <span class="muted">Page ${number(page)} of ${number(pages)}</span>
        <button type="button" class="button" data-files-action="duplicates-next" ${page >= pages ? 'disabled' : ''}>Next groups</button>
      </nav>` : '<div class="empty">No duplicate group found here.</div>'}`;
}

async function filesDuplicates(token) {
  const scope = filesTools.scope;
  const cached = filesTools.duplicates;
  if (!cached || cached.scope !== scope || Date.now() - cached.at > FILES_CACHE_MS) {
    filesPaint(`${filesScopeForm('Groups of files with the same content.')}${filesLoading('Comparing hashes… this read takes a few seconds on a large index.')}`);
    const query = new URLSearchParams({ limit: String(FILES_DUPLICATES_LIMIT) });
    const scoped = new URLSearchParams();
    if (scope) { query.set('root', scope); scoped.set('root', scope); }
    const [groups, summary] = await Promise.all([
      filesSettled(api(`/storage/duplicates?${query}`)), filesSettled(api(`/storage/summary${scope ? `?${scoped}` : ''}`))
    ]);
    if (filesStale(token)) return;
    filesTools.duplicates = { groups, summary, scope, at: groups.error ? 0 : Date.now() };
    filesTools.duplicatesPage = 1;
  }
  filesPaint(filesDuplicatesSection());
}

function filesCleanupCard(item) {
  const sample = array(item.files);
  const saving = item.potentialSavings;
  return `<article class="card cleanup-card">
    <div class="card-title"><h3>${e(FILES_CLEANUP_TITLES[item.type] || label(item.type))}</h3><span class="pill ${item.priority === 'high' ? 'warn' : ''}">${e(item.priority || 'review')}</span></div>
    <p>${e(item.message || '—')}</p>
    <div class="metric-row"><span>Possible saving</span><strong>${saving == null ? 'not measured' : bytes(saving)}</strong></div>
    ${item.reviewBytes == null ? '' : `<div class="metric-row"><span>Size of the sampled files</span><strong>${bytes(item.reviewBytes)}</strong></div>`}
    ${item.evidence ? `<div class="metric-row"><span>Evidence</span><strong class="mono">${e(item.evidence)}</strong></div>` : ''}
    ${sample.length ? `<details><summary>${number(sample.length)} sampled files</summary>${filesPathList(sample, (file) => ` <span class="muted">${filesSize(file.size ?? file.sizeFormatted)}${file.age ? ` · ${e(file.age)} old` : ''}</span>`)}</details>` : ''}
  </article>`;
}

async function filesCleanup(token) {
  const scope = filesTools.scope;
  const form = () => filesScopeForm('Suggestions computed from the index, for review.');
  filesPaint(`${form()}${filesLoading('Reading the suggestions…')}`);
  const read = await filesSettled(api(`/storage/cleanup${scope ? `?${new URLSearchParams({ root: scope })}` : ''}`));
  if (filesStale(token)) return;
  if (read.error) { filesPaint(`${form()}<div class="notice warning">The cleanup suggestions could not be read from Data: ${e(read.error)}.</div>`); return; }
  const items = array(read.data?.recommendations);
  filesPaint(`${form()}
    <div class="notice">These are leads to look at, drawn from samples of the index. Nothing is deleted from this page, and a file's size or age alone is not a reason to delete it.</div>
    ${items.length ? `<div class="grid two">${items.map(filesCleanupCard).join('')}</div>` : '<div class="empty">Data returned no suggestion.</div>'}`);
}

// ------------------------------------------------------------------- events

function filesShowFolder(path) {
  const kept = new URLSearchParams(state.filesQuery);
  const params = new URLSearchParams({ root: path });
  for (const key of ['sizeUnit', 'sortBy', 'sortOrder', 'limit']) if (kept.get(key)) params.set(key, kept.get(key));
  state.filesPage = 1;
  filesGo(params);
}

document.addEventListener('click', (event) => {
  if (state.tab !== 'files') return;
  const view = event.target.closest?.('[data-files-view]')?.dataset.filesView;
  if (view && FILES_VIEWS[view]) { filesTools.view = view; filesGo(); return; }
  const folder = event.target.closest?.('[data-files-folder]');
  if (folder) { Object.assign(filesTools, { folder: folder.dataset.filesFolder || '', view: 'folders' }); filesGo(); return; }
  const show = event.target.closest?.('[data-files-show]')?.dataset.filesShow;
  if (show) { filesShowFolder(show); return; }
  const action = event.target.closest?.('[data-files-action]')?.dataset.filesAction;
  if (action === 'reset') { state.filesPage = 1; filesGo(new URLSearchParams()); }
  if (action === 'refresh') { filesTools.duplicates = null; filesLoadStats(true); filesGo(); }
  if (action === 'scope-clear') { Object.assign(filesTools, { scope: '', duplicates: null }); filesGo(); }
  if (action === 'duplicates-previous' || action === 'duplicates-next') {
    filesTools.duplicatesPage = Math.max(1, filesTools.duplicatesPage + (action === 'duplicates-next' ? 1 : -1));
    filesGo();
  }
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'filesScope') return;
  event.preventDefault();
  Object.assign(filesTools, { scope: String(event.target.elements.root.value || '').trim().replace(/(.)\/+$/, '$1'), duplicates: null });
  filesGo();
});
