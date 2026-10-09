'use strict';

/**
 * Compact, read-only views of the Data storage index for Nestor: a summary of
 * what is indexed, and a bounded file-name search.
 *
 * Both read the index the storage collector last wrote, never the disks. The
 * age and outcome of the last scan of each source travel with every answer, and
 * a partial or failed scan is said plainly instead of being presented as a
 * complete index. Only GET requests are sent; file contents, hashes and
 * database ids never leave this module.
 */

const REQUEST_TIMEOUT_MS = 6000;
const SCAN_LOOKBACK = 40;
const MAX_ROOTS = 8;
const MAX_SCANNERS = 8;
const DEFAULT_FILES = 10;
const MAX_FILES = 25;
const MAX_QUERY = 80;
const MAX_NAME = 255;
const MAX_FOLDER = 1024;
const TERMINAL = Object.freeze(['complete', 'partial', 'failed', 'stopped']);
const STATUS_WORDS = Object.freeze({
  complete: 'complet', partial: 'partiel', failed: 'échoué', stopped: 'interrompu'
});

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENTS' });
}

function unavailable(message) {
  return Object.assign(new Error(message), { code: 'DATA_UNAVAILABLE' });
}

function time(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function share(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? Math.round(number * 1000) / 1000 : null;
}

function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function hasControl(text) {
  return [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function ageLabel(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} jours`;
}

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 1 : 2);
  return `${text.replace('.', ',')} ${units[unit]}`;
}

function percentLabel(value) {
  return value === null ? 'inconnue' : `${Math.round(value * 100)} %`;
}

function plainObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('arguments must be an object');
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw invalid(`unknown argument: ${unknown[0].slice(0, 40)}`);
  return value;
}

/**
 * Sources Data declares, each with the last finished scan Data still lists.
 * `agentsBody` and `scansBody` are the `data` members of `/storage/agents` and
 * `/storage/scans`.
 */
function projectSources({ agentsBody, scansBody, now }) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const declared = agentsBody?.sources && typeof agentsBody.sources === 'object' ? agentsBody.sources : {};
  const scans = Array.isArray(scansBody?.scans) ? scansBody.scans : [];
  const names = [...new Set([
    ...Object.keys(declared),
    ...scans.map((scan) => scan?.config?.source).filter((name) => typeof name === 'string' && name)
  ])].slice(0, MAX_ROOTS);

  return names.map((name) => {
    // Data lists scans newest first.
    const own = scans.filter((scan) => scan?.config?.source === name);
    const finished = own.find((scan) => TERMINAL.includes(scan.status));
    const newer = finished ? own.slice(0, own.indexOf(finished)) : own;
    const at = finished ? time(finished.finished_at) || time(finished.started_at) : null;
    const root = declared[name]?.canonicalRoot
      || (Array.isArray(finished?.config?.roots) ? finished.config.roots[0] : null) || null;
    return {
      source: clip(name, 64),
      root: clip(root, 255),
      lastScan: finished ? {
        status: finished.status,
        finishedAt: at ? new Date(at).toISOString() : null,
        ageMs: at ? Math.max(0, nowMs - at) : null,
        filesSeen: count(finished.counts?.files_seen),
        errors: count(finished.counts?.errors)
      } : null,
      scanInProgress: newer.some((scan) => ['running', 'hashing', 'queued'].includes(scan.status))
    };
  });
}

/** One French clause per source, worst news first. */
function scanSentence(sources) {
  if (!sources.length) return 'Aucune source de stockage déclarée : l\'âge de l\'index est inconnu.';
  const clauses = sources.map((source) => {
    const scan = source.lastScan;
    if (!scan) return `${source.source} : aucun scan terminé connu`;
    const age = scan.ageMs === null ? 'date inconnue' : `il y a ${ageLabel(scan.ageMs)}`;
    if (scan.status === 'complete') return `${source.source} : dernier scan complet ${age}`;
    return `${source.source} : ATTENTION, dernier scan ${STATUS_WORDS[scan.status]} ${age}, index possiblement incomplet`;
  });
  return `${clauses.join(' ; ')}.`;
}

function scanWarnings(sources) {
  return sources.filter((source) => !source.lastScan || source.lastScan.status !== 'complete')
    .map((source) => ({ source: source.source, status: source.lastScan ? source.lastScan.status : 'never_scanned' }));
}

function reader(deps) {
  const fetchData = deps.fetchData || require('./dataServiceClient').fetchData;
  return async (route, query = '') => {
    let answer;
    try { answer = await fetchData(route, { query, timeoutMs: REQUEST_TIMEOUT_MS }); }
    catch (error) {
      throw unavailable(error?.name === 'TimeoutError' ? 'Data storage index did not answer in time' : 'Data storage index is unreachable');
    }
    const { response, body } = answer;
    if (!response.ok || body?.status === 'error' || !body?.data || typeof body.data !== 'object') {
      const error = unavailable(`Data storage index answered ${response.status}`);
      error.httpStatus = response.status;
      error.dataMessage = typeof body?.message === 'string' ? body.message.slice(0, 200) : '';
      throw error;
    }
    return body.data;
  };
}

function projectSummary({ summaryBody, agentsBody, scansBody, rootStats = {}, now = new Date() }) {
  const sources = projectSources({ agentsBody, scansBody, now });
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const scanners = (Array.isArray(agentsBody?.scanners) ? agentsBody.scanners : []).slice(0, MAX_SCANNERS).map((scanner) => {
    const seen = time(scanner.lastSeen);
    return {
      id: clip(String(scanner.scannerId || ''), 64) || null,
      host: clip(scanner.hostname, 64),
      active: scanner.active === true,
      lastSeenAt: seen ? new Date(seen).toISOString() : null,
      lastSeenAgeMs: seen ? Math.max(0, nowMs - seen) : null
    };
  });
  const collectorAlive = scanners.some((scanner) => scanner.active);
  const totalFiles = count(summaryBody?.totalFiles);
  const totalBytes = count(summaryBody?.totalSize);
  const hashCoverage = { files: share(summaryBody?.hashCoverageFiles), bytes: share(summaryBody?.hashCoverageBytes) };
  const warnings = scanWarnings(sources);

  const roots = sources.map((source) => {
    const stats = source.root ? rootStats[source.root] : null;
    return {
      source: source.source,
      root: source.root,
      // null means Data did not answer for this root; it is not zero.
      files: stats ? count(stats.count) : null,
      bytes: stats ? count(stats.totalSize) : null,
      sizeLabel: stats ? sizeLabel(count(stats.totalSize)) : null,
      lastScan: source.lastScan,
      scanInProgress: source.scanInProgress
    };
  });

  const totals = totalFiles === null ? 'Totaux de l\'index indisponibles.'
    : `Index : ${totalFiles} fichiers, ${sizeLabel(totalBytes) || 'taille inconnue'}, empreintes calculées pour ${percentLabel(hashCoverage.files)} des fichiers.`;
  const collector = !scanners.length ? 'Aucun collecteur de stockage connu.'
    : collectorAlive ? 'Collecteur actif.' : 'ATTENTION : collecteur de stockage inactif, l\'index ne se met plus à jour.';

  return {
    summary: `${totals} ${scanSentence(sources)} ${collector}`,
    totalFiles,
    totalBytes,
    totalSizeLabel: sizeLabel(totalBytes),
    hashCoverage,
    roots,
    scanWarnings: warnings,
    collector: { alive: collectorAlive, scanners },
    readFrom: 'index'
  };
}

async function readStorageSummary(input = {}, deps = {}) {
  plainObject(input, []);
  const read = reader(deps);
  // The source list answers at once; everything else is then read together so
  // the slow totals do not add up.
  const agentsBody = await read('/api/v1/storage/agents');
  const roots = Object.values(agentsBody.sources && typeof agentsBody.sources === 'object' ? agentsBody.sources : {})
    .map((source) => source?.canonicalRoot).filter((root) => typeof root === 'string' && root).slice(0, MAX_ROOTS);
  const rootStats = {};
  const [summaryBody, scansBody] = await Promise.all([
    read('/api/v1/storage/summary'),
    read('/api/v1/storage/scans', `limit=${SCAN_LOOKBACK}`),
    // A per-root total is a detail: when one fails, that root says "unknown"
    // and the rest of the summary still answers.
    ...roots.map(async (root) => {
      try { rootStats[root] = (await read('/api/v1/storage/files/stats', new URLSearchParams({ root }).toString())).total || null; }
      catch { rootStats[root] = null; }
    })
  ]);
  return projectSummary({ summaryBody, agentsBody, scansBody, rootStats, now: deps.now ? deps.now() : new Date() });
}

function validateSearch(input) {
  const args = plainObject(input, ['query', 'extension', 'category', 'root', 'limit']);
  if (typeof args.query !== 'string') throw invalid('query must be a string');
  const query = args.query.trim();
  if (query.length < 2 || query.length > MAX_QUERY || hasControl(query)) {
    throw invalid(`query must contain 2-${MAX_QUERY} printable characters`);
  }
  let extension = '';
  if (args.extension !== undefined) {
    if (typeof args.extension !== 'string' || !/^\.?[A-Za-z0-9_-]{1,16}$/.test(args.extension)) {
      throw invalid('extension must be 1-16 letters, digits, - or _');
    }
    extension = args.extension.replace(/^\./, '').toLowerCase();
  }
  let category = '';
  if (args.category !== undefined) {
    if (typeof args.category !== 'string' || !/^[a-z0-9_]{1,32}$/.test(args.category)) {
      throw invalid('category must be 1-32 lowercase letters, digits or _');
    }
    category = args.category;
  }
  if (extension && category) throw invalid('give extension or category, not both');
  let root = '';
  if (args.root !== undefined) {
    if (typeof args.root !== 'string' || !args.root.trim() || args.root.length > 255 || hasControl(args.root)) {
      throw invalid('root must be a declared source name or its root path');
    }
    root = args.root.trim();
  }
  let limit = DEFAULT_FILES;
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_FILES) {
      throw invalid(`limit must be an integer from 1 to ${MAX_FILES}`);
    }
    limit = args.limit;
  }
  return { query, extension, category, root, limit };
}

function projectFile(file) {
  const seconds = Number(file?.mtime);
  const modified = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
  const bytes = count(file?.size);
  return {
    // Names and folders are the owner's data, relayed unchanged apart from length.
    name: clip(String(file?.filename ?? ''), MAX_NAME),
    folder: clip(String(file?.dirname ?? ''), MAX_FOLDER),
    bytes,
    sizeLabel: sizeLabel(bytes),
    modifiedAt: modified && !Number.isNaN(modified.getTime()) ? modified.toISOString() : null,
    extension: clip(file?.ext || '', 32) || null,
    category: clip(file?.category || '', 32) || null
  };
}

function projectSearch({ browseBody, sources, search }) {
  const rows = Array.isArray(browseBody?.files) ? browseBody.files : [];
  const files = rows.slice(0, search.limit).map(projectFile);
  const reported = count(browseBody?.pagination?.total);
  const total = reported === null ? files.length : Math.max(reported, files.length);
  const truncated = total > files.length;
  const found = total === 0 ? 'Aucun fichier de l\'index ne correspond.'
    : truncated ? `${total} fichiers correspondent dans l'index ; seuls les ${files.length} modifiés le plus récemment sont listés, la liste est tronquée.`
      : `${total} fichier${total > 1 ? 's correspondent' : ' correspond'} dans l'index.`;
  return {
    summary: `${found} Recherche faite dans l'index, pas sur les disques : ${scanSentence(sources)}`,
    searchedIn: 'index',
    total,
    returned: files.length,
    truncated,
    order: 'modified_desc',
    filters: { extension: search.extension || null, category: search.category || null, root: search.rootPath || null },
    index: { sources, scanWarnings: scanWarnings(sources) },
    files
  };
}

async function findFiles(input = {}, deps = {}) {
  const search = validateSearch(input);
  const read = reader(deps);
  const [agentsBody, scansBody] = await Promise.all([
    read('/api/v1/storage/agents'),
    read('/api/v1/storage/scans', `limit=${SCAN_LOOKBACK}`)
  ]);
  let sources = projectSources({ agentsBody, scansBody, now: deps.now ? deps.now() : new Date() });
  if (search.root) {
    // Only a source Data declares can scope a search: no arbitrary path prefix.
    const match = sources.find((source) => source.source === search.root
      || (source.root && source.root.replace(/\/+$/, '') === search.root.replace(/\/+$/, '')));
    if (!match || !match.root) {
      throw invalid(`root must be one of: ${sources.filter((source) => source.root).map((source) => source.source).join(', ') || '(no declared source)'}`);
    }
    search.rootPath = match.root;
    sources = [match];
  }
  const params = new URLSearchParams({ search: search.query, limit: String(search.limit), page: '1', sortBy: 'mtime', sortOrder: 'desc' });
  if (search.extension) params.set('ext', search.extension);
  if (search.category) params.set('category', search.category);
  if (search.rootPath) params.set('root', search.rootPath);
  let browseBody;
  try { browseBody = await read('/api/v1/storage/files/browse', params.toString()); }
  catch (error) {
    if (error.httpStatus === 400 && /category/i.test(error.dataMessage || '')) throw invalid('category is not one Data knows');
    throw error;
  }
  return projectSearch({ browseBody, sources, search });
}

module.exports = {
  DEFAULT_FILES, MAX_FILES, MAX_QUERY,
  ageLabel, sizeLabel, projectSources, projectSummary, projectSearch,
  readStorageSummary, findFiles, validateSearch
};
