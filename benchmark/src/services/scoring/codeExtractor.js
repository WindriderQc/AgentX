'use strict';

/**
 * Pull the candidate's program out of a model response.
 *
 * A response is prose with code in it, not a file. Models fence their code
 * about half the time: of the four coding responses in the judge calibration
 * set, one arrives in a tagged fence and three arrive raw. Both must reach the
 * runner intact, because anything this module drops reads downstream as a
 * wrong answer rather than as a harness defect.
 *
 * Pure text handling: no file, no process, no judgement about whether the code
 * is correct. Extraction never fails softly; when nothing here looks like a
 * program it says `no_code`, and the scorer records that as a zero with its
 * own status rather than sending an empty file to a sandbox.
 */

const LANGUAGE_ALIASES = Object.freeze({
    python: ['python', 'python3', 'py', 'pyt', 'ipython'],
    javascript: ['javascript', 'js', 'node', 'nodejs', 'mjs', 'cjs']
});

/**
 * Fence tags that carry something other than the candidate's program. A block
 * tagged this way is never treated as code, even when nothing else matches.
 */
const NON_CODE_TAGS = Object.freeze([
    'text', 'txt', 'plaintext', 'plain', 'output', 'result', 'results',
    'console', 'log', 'logs', 'stdout', 'stderr', 'example', 'markdown', 'md'
]);

const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)/;

const CODE_LINE_PATTERNS = Object.freeze({
    python: [
        /^(async\s+)?def\s+[A-Za-z_]/,
        /^class\s+[A-Za-z_]/,
        /^(import|from)\s+[A-Za-z_.]/,
        /^@[A-Za-z_]/,
        /^#/,
        /^(if|elif|else|for|while|with|try|except|finally|match|case)\b.*:\s*(#.*)?$/,
        /^(return|yield|raise|assert|pass|break|continue|global|nonlocal|del|print)\b/
    ],
    javascript: [
        /^(export\s+)?(async\s+)?function\s*\*?\s*[A-Za-z_$]/,
        /^(export\s+)?(const|let|var)\s+[A-Za-z_$[{]/,
        /^(export\s+)?class\s+[A-Za-z_$]/,
        /^(import|require)\b/,
        /^\/\//,
        /^\/\*/,
        /^['"]use strict['"]/,
        /^module\.exports\b/,
        /^(if|for|while|switch|try|catch|finally|do)\s*[({]/,
        /^(return|throw|break|continue|await|yield)\b/
    ]
});

// Shared by both languages: an assignment (including a tuple or destructuring
// target list), a bare call, or a closing bracket continuing a construct that
// opened above.
const GENERIC_CODE_PATTERNS = Object.freeze([
    /^[A-Za-z_$][\w$.[\]'"]*(\s*,\s*[A-Za-z_$][\w$.[\]'"]*)*\s*(\+|-|\*|\/|\|\||\?\?)?=[^=]/,
    /^[A-Za-z_$][\w$.]*\s*\(.*\)\s*;?\s*$/,
    /^[)\]}]/
]);

function languageAliases(language) {
    return LANGUAGE_ALIASES[language] || [];
}

function matchesAny(line, language) {
    const patterns = CODE_LINE_PATTERNS[language] || [];
    return patterns.some((pattern) => pattern.test(line))
        || GENERIC_CODE_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Whether one line, read on its own, belongs to a program rather than to the
 * prose around it. Indented lines count as code: prose is not indented once a
 * definition has opened.
 */
function looksLikeCodeLine(line, language) {
    if (typeof line !== 'string' || line.trim() === '') return false;
    if (/^\s+\S/.test(line)) return true;
    return matchesAny(line, language);
}

/**
 * Whether a line opens a program at column zero: a definition, an import, an
 * assignment or a call. Prose sentences match none of these, and an indented
 * line cannot open a program.
 */
function startsProgram(line, language) {
    if (typeof line !== 'string' || /^\s/.test(line)) return false;
    return matchesAny(line, language);
}

function escapeIdentifier(entry) {
    return String(entry).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a chunk of code defines `entry`, so the extractor can keep the block
 * that answers the task together with the helpers above it.
 */
function definesEntry(code, language, entry) {
    if (!entry) return false;
    const name = escapeIdentifier(entry);
    const patterns = language === 'python'
        ? [
            new RegExp(`(^|\\n)\\s*(async\\s+)?def\\s+${name}\\s*\\(`),
            new RegExp(`(^|\\n)\\s*class\\s+${name}\\s*[(:]`),
            new RegExp(`(^|\\n)\\s*${name}\\s*=\\s*lambda\\b`)
        ]
        : [
            new RegExp(`(^|\\n)\\s*(export\\s+)?(async\\s+)?function\\s*\\*?\\s*${name}\\s*\\(`),
            new RegExp(`(^|\\n)\\s*(export\\s+)?(const|let|var)\\s+${name}\\s*=`),
            new RegExp(`(^|\\n)\\s*(export\\s+)?class\\s+${name}\\s*[{e]`),
            new RegExp(`(^|\\n)\\s*${name}\\s*[:=]\\s*(async\\s*)?(function|\\()`)
        ];
    return patterns.some((pattern) => pattern.test(code));
}

/**
 * Split a response into fenced blocks. Unterminated fences are honoured to the
 * end of the text: a response cut off by a token budget still carries usable
 * code.
 */
function fencedBlocks(text) {
    const lines = String(text).split(/\r?\n/);
    const blocks = [];
    let open = null;
    let context = [];

    for (const line of lines) {
        const fence = FENCE.exec(line);
        if (open) {
            const closes = fence && line.trim().startsWith(open.marker[0].repeat(3)) && !fence[2];
            if (closes) {
                blocks.push({ tag: open.tag, code: open.lines.join('\n'), context: open.context });
                open = null;
            } else {
                open.lines.push(line);
            }
            continue;
        }
        if (fence) {
            open = { marker: fence[1], tag: (fence[2] || '').trim().toLowerCase(), lines: [], context: context.join('\n') };
            context = [];
        } else {
            context.push(line);
        }
    }
    if (open) blocks.push({ tag: open.tag, code: open.lines.join('\n'), context: open.context });

    return blocks.filter((block) => block.code.trim() !== '');
}

/**
 * Blocks that may hold the candidate's program, in the order they appear.
 * Untagged and language-tagged blocks are preferred; when a response tags
 * everything with something unfamiliar, unknown tags are accepted rather than
 * reporting no code at all.
 */
function candidateBlocks(blocks, language) {
    const aliases = languageAliases(language);
    const preferred = blocks.filter((block) => block.tag === '' || aliases.includes(block.tag));
    if (preferred.length > 0) return preferred;
    return blocks.filter((block) => !NON_CODE_TAGS.includes(block.tag)
        && !Object.values(LANGUAGE_ALIASES).flat().includes(block.tag));
}

/**
 * Test-file fixtures do not name an entry point. A CommonJS export identifies
 * a submitted module, but does not end it: helpers may follow the export.
 * Only omit subsequent blocks explicitly introduced as separate usage,
 * wiring, adapter or test examples. Unlabelled fragments stay in the program;
 * guessing that they are examples could hide a genuine candidate failure.
 */
function commonJsModuleBlocks(blocks) {
    const exportsModule = /(^|\n)\s*(?:module\s*\.\s*exports(?:\s*\.\s*[\w$]+)?|exports\s*\.\s*[\w$]+)\s*=(?!=)/;
    const commentsAndStrings = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
    const hasExport = block => exportsModule.test(block.code.replace(commentsAndStrings, ''));
    const exampleContext = /\b(?:usage|examples?|wiring)\b|\bcallers?\s*(?:\([^)]*\)\s*)?(?:inject|use|pass)\b|\b(?:in\s+tests|tests?\s+like|pass\s+stubs|adapter\s+can\s+wrap)\b/i;
    const moduleIndex = blocks.findIndex(hasExport);
    if (moduleIndex === -1) return blocks;
    return blocks.filter((block, index) => index <= moduleIndex
        || hasExport(block) || !exampleContext.test(block.context));
}

/**
 * Drop prose that trails unfenced code. A model that answers with a function
 * and then explains it would otherwise hand the runner a file that does not
 * parse, which would read as a wrong answer.
 */
function trimTrailingProse(lines, language) {
    let end = lines.length;
    while (end > 0) {
        const line = lines[end - 1];
        if (line.trim() === '') { end -= 1; continue; }
        if (looksLikeCodeLine(line, language)) break;
        end -= 1;
    }
    return lines.slice(0, end);
}

function fromRawText(text, language) {
    const lines = String(text).split(/\r?\n/);
    const firstContent = lines.findIndex((line) => line.trim() !== '');
    if (firstContent === -1) return null;

    const start = lines.findIndex((line) => startsProgram(line, language));
    if (start === -1) return null;

    const body = trimTrailingProse(lines.slice(start), language);
    if (body.length === 0) return null;

    return {
        code: body.join('\n').trim(),
        source: start === firstContent ? 'raw' : 'raw_after_prose'
    };
}

/**
 * Extract the candidate's program from a model response.
 *
 * @param {string} text the model response
 * @param {{ language: string, entry?: string|null }} options
 * @returns {{ status: 'ok'|'no_code', code: string, source: string|null, blocks: number }}
 *   `source` says where the code came from, which belongs on the result row:
 *   an extraction that had to skip a preamble is worth seeing when a score
 *   looks wrong.
 */
function extractCode(text, { language, entry = null } = {}) {
    const empty = { status: 'no_code', code: '', source: null, blocks: 0 };
    if (typeof text !== 'string' || text.trim() === '') return empty;
    if (!CODE_LINE_PATTERNS[language]) return empty;

    const blocks = fencedBlocks(text);
    const candidates = candidateBlocks(blocks, language);

    if (candidates.length > 0) {
        // Keep everything up to the last block that defines the entry point:
        // helpers come first, and a later redefinition is the one the model
        // settled on, which is also the one the interpreter would keep.
        let lastEntry = -1;
        for (let index = 0; index < candidates.length; index += 1) {
            if (definesEntry(candidates[index].code, language, entry)) lastEntry = index;
        }
        const kept = lastEntry !== -1 ? candidates.slice(0, lastEntry + 1)
            : !entry && language === 'javascript' ? commonJsModuleBlocks(candidates) : candidates;
        const code = kept.map((block) => block.code.replace(/\s+$/, '')).join('\n\n').trim();
        if (code !== '') {
            return { status: 'ok', code, source: 'fenced', blocks: kept.length };
        }
    }

    const raw = fromRawText(text, language);
    if (raw) return { status: 'ok', code: raw.code, source: raw.source, blocks: 0 };
    return { ...empty, blocks: blocks.length };
}

module.exports = {
    LANGUAGE_ALIASES,
    extractCode,
    definesEntry,
    looksLikeCodeLine,
    startsProgram
};
