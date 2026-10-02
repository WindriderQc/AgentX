'use strict';

const fs = require('fs');
const { logger } = require('./logger');

// Directory roles the file-metadata classifier keys on. A rule asks "is this
// path inside an install-media directory / a mail store / a backup?" instead
// of naming one share's folders, so the same rule holds for any tree that
// follows the convention.
//
// `roleAliases` lists the built-in directory names per role. An entry is a
// literal name unless it starts with `re:`, in which case the rest is a regex
// fragment. Each entry is matched as one or more whole path segments (a
// literal may contain "/"), case-insensitively, against a normalized path.
// A deployment extends these lists with an out-of-Git JSON file named by
// DATA_PATH_ROLE_ALIASES_FILE (see docs/OPERATIONS.md); those entries merge
// into the same arrays before the patterns are built.
const ENV_VAR = 'DATA_PATH_ROLE_ALIASES_FILE';
const ALIAS_FILE_VERSION = 1;
const MAX_ENTRIES_PER_ROLE = 200;
const MAX_ENTRY_LENGTH = 64;
const SEP = '[\\\\/]';
const NOT_SEP = '[^\\\\/]';

const roleAliases = Object.freeze({
  // backup, backups, cloud-backup, my backups — never "nobackup".
  BACKUP_DIR: ['re:(?:[^\\\\/]*[-_ .])?backups?'],
  // A working-tree .git directory or a bare/detached <name>.git store.
  GIT_DIR: ['.git', 're:[^\\\\/]+\\.git'],
  INSTALL_MEDIA: ['install-media', 'installer', 'installers', 'cds', 're:disk\\d+'],
  SOFTWARE_DIR: ['software', 'shared-software', 'shared software', 'program files'],
  SOURCE_TREE: [
    'project', 'projects', 'repo', 'repos', 'src', 'source', 'source_code', 'code',
    'sketch', 'sketches', 'firmware'
  ],
  SCHOOL_TREE: ['school', 'coursework'],
  EDA_DIR: ['eda', 'orcad', 'kicad', 'pcb', 'schematic', 'schematics'],
  EMBEDDED_DIR: ['embedded', 'mcu', 'atmel', 'avr', 'iar', 'keil'],
  WORKBENCH_DIR: ['re:ewb\\d+'],
  // Thunderbird-style stores: Mail/<host or Local Folders>/… and *.sbd folders.
  MAIL_DIR: ['re:(?:mail|imapmail)/(?:local folders|[^\\\\/]+\\.[^\\\\/]+)', 're:[^\\\\/]+\\.sbd'],
  WEB_DIR: ['web', 'www', 'website', 'websites'],
  GAMES_DIR: ['games', 'emulator', 'emulators'],
  ASSET_DIR: ['asset', 'assets', 'resources', 'partsys'],
  MODEL_DIR: ['3d-models', '3d models', 'meshes', 'assets/models', 'asset/models', 'media/models'],
  NOTES_DIR: ['notes'],
  SCANS_DIR: ['scan', 'scans'],
  CONTACTS_DIR: [
    'contact', 'contacts', 'address book', 'address-book', 'addressbook', 'vcards',
    're:phone[- ]?(?:docs|export|backup|contacts)'
  ],
  MACROS_DIR: ['macros'],
  SCRIPTS_DIR: ['scripts'],
  PRINTER_DIR: ['sys', 'macros', 're:printer[^\\\\/]*'],
  DISC_DIR: ['video', 'videos', 'movies', 'disc', 'discs']
});
const ROLE_KEYS = Object.freeze(Object.keys(roleAliases));

let cache = null;

function escapeLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function entryPattern(entry) {
  return entry.startsWith('re:') ? `(?:${entry.slice(3)})` : escapeLiteral(entry.toLowerCase());
}

function alternation(key, extra) {
  return [...roleAliases[key], ...(extra[key] || [])].map(entryPattern).join('|');
}

function segment(alts) {
  return new RegExp(`(?:^|${SEP})(?:${alts})(?:${SEP}|$)`, 'i');
}

function child(alts, tail) {
  return new RegExp(`(?:^|${SEP})(?:${alts})${SEP}${tail}`, 'i');
}

function buildRoles(extra) {
  const alt = Object.fromEntries(ROLE_KEYS.map(key => [key, alternation(key, extra)]));
  const roles = Object.fromEntries(ROLE_KEYS.map(key => [key, segment(alt[key])]));
  // Composed shapes: a role directory plus the structure the rule expects
  // underneath it. Built once so the rules never rebuild regexes per call.
  roles.BACKUP_INFO = child(alt.BACKUP_DIR, 'info$');
  roles.GIT_OBJECT = child(alt.GIT_DIR, 'objects/[0-9a-f]{2}/[0-9a-f]{38}$');
  roles.MAIL_STORE_FILE = child(alt.MAIL_DIR, `${NOT_SEP}+$`);
  roles.MAIL_INDEX_FILE = child(alt.MAIL_DIR, `${NOT_SEP}+\\.msf$`);
  roles.NOTES_FILE = child(alt.NOTES_DIR, `${NOT_SEP}+$`);
  roles.SCANS_FILE = child(alt.SCANS_DIR, `${NOT_SEP}+$`);
  roles.SCRIPTS_FILE = child(alt.SCRIPTS_DIR, `${NOT_SEP}+$`);
  roles.MACROS_FILE = child(alt.MACROS_DIR, `${NOT_SEP}+$`);
  roles.PRINTER_GCODE = child(alt.PRINTER_DIR, `${NOT_SEP}+\\.g$`);
  roles.PROJECT_MEDIA = child(alt.SOURCE_TREE, `${NOT_SEP}+/media/`);
  roles.SOURCE_INSIGHT_FILE = child(alt.SOURCE_TREE, `${NOT_SEP}+/(?:backup of )?${NOT_SEP}+\\.${NOT_SEP}+$`);
  return Object.freeze(roles);
}

function validateAliasFile(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'top level is not an object';
  if (parsed.version !== ALIAS_FILE_VERSION) return `version must be ${ALIAS_FILE_VERSION}`;
  const roles = parsed.roles;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return '"roles" is not an object';
  for (const [key, entries] of Object.entries(roles)) {
    if (!ROLE_KEYS.includes(key)) return `unknown role "${key}" (known: ${ROLE_KEYS.join(', ')})`;
    if (!Array.isArray(entries)) return `role "${key}" is not an array`;
    if (entries.length > MAX_ENTRIES_PER_ROLE) {
      return `role "${key}" has ${entries.length} entries (max ${MAX_ENTRIES_PER_ROLE})`;
    }
    for (const entry of entries) {
      if (typeof entry !== 'string' || !entry.trim()) return `role "${key}" has a non-string or empty entry`;
      if (entry.length > MAX_ENTRY_LENGTH) return `role "${key}" entry exceeds ${MAX_ENTRY_LENGTH} characters`;
      if (entry.startsWith('re:')) {
        try { new RegExp(entry.slice(3), 'i'); } catch (err) { return `role "${key}" entry is not a valid regex: ${err.message}`; }
      }
    }
  }
  return null;
}

function loadAliasFile() {
  const file = process.env[ENV_VAR];
  if (!file) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger.warn(`${ENV_VAR} ignored: ${file}: ${err.code ? `cannot read file (${err.code})` : `invalid JSON (${err.message})`}`);
    return {};
  }
  const problem = validateAliasFile(parsed);
  if (problem) {
    logger.warn(`${ENV_VAR} ignored: ${file}: ${problem}`);
    return {};
  }
  return parsed.roles;
}

// Roles are built on first use so the alias file is read once per process,
// and only when the variable is set.
function roles() {
  if (!cache) cache = buildRoles(loadAliasFile());
  return cache;
}

function resetPathRoleAliases() {
  cache = null;
}

module.exports = {
  ENV_VAR,
  MAX_ENTRIES_PER_ROLE,
  MAX_ENTRY_LENGTH,
  ROLE_KEYS,
  roleAliases,
  roles,
  resetPathRoleAliases,
  validateAliasFile
};
