"""Step planner and loop for runner-owned reports (#834).

One report execution keeps its single Core authority (claim, call limit,
deadline, queue reservation) but runs several short worker sessions in fresh
context. The runner chooses each group of documents from the lane capability
profile, gives the model only that group, verifies and merges its JSON result
into the ledger and re-renders the report after every step, so a stop loses
at most one step.
"""
from __future__ import annotations

import json
import os
import posixpath

CHARS_PER_TOKEN = 3.6
DEFAULT_STEP_CONTEXT = 24576
MIN_STEP_CONTEXT = 8192
MAX_STEP_CONTEXT = 65536
DOC_SHARE = 0.35          # of the step context, for the documents themselves
MAX_GROUP_DOCS = 5
MAX_PARTIAL_ROUNDS = 3
STEP_CALLS = 16
STEP_SECONDS = 20 * 60
WRITER_CALLS = 6
WRITER_SECONDS = 8 * 60
LEGACY_CALLS = 10
RESULT_BYTES = 256 * 1024
FEEDBACK_CHARS = 3000

GROUP_SCHEMA = (
    '{"documents": [{"path": "<document path>", "state": "reviewed" | "partial" | "blocked", '
    '"evidence": [{"path": "<source path>", "line": <1-based line>, "check": "<claim checked>"}], "note": "<optional>"}], '
    '"findings": [{"kind": "inaccuracy" | "obsolete" | "gap", "severity": "high" | "medium" | "low", "title": "<short>", '
    '"document": {"path": "<document path>", "line": <line in the document>}, '
    '"evidence": [{"path": "<source path>", "line": <line>, "check": "<what proves it>"}], "correction": "<proposed fix>"}]}'
)


def step_budget(capability=None):
    """Step size from the lane capability profile, never from a guess.

    The recommended step context comes from the agent workload probe; without
    it, the measured speed knee; without that, a conservative default."""
    agent = (capability or {}).get('agent') or {}
    context = (capability or {}).get('context') or {}
    source = 'default'
    step = DEFAULT_STEP_CONTEXT
    if isinstance(agent.get('recommendedStepContext'), int) and agent['recommendedStepContext'] > 0:
        step, source = agent['recommendedStepContext'], 'agent_workload'
    elif isinstance(context.get('knee'), int) and context['knee'] > 0:
        step, source = context['knee'], 'speed_knee'
    step = max(MIN_STEP_CONTEXT, min(MAX_STEP_CONTEXT, step))
    return {'stepContext': step, 'docTokens': int(step * DOC_SHARE), 'calls': STEP_CALLS, 'seconds': STEP_SECONDS,
            'source': source}


def doc_tokens(size_bytes):
    return max(1, int(size_bytes / CHARS_PER_TOKEN))


def _next_range(row, lines, chunk):
    done = {tuple(r) for r in row.get('ranges', [])}
    start = 1
    while start <= lines:
        end = min(lines, start + chunk - 1)
        if (start, end) not in done:
            return (start, end, end >= lines)
        start = end + 1
    return None


def plan_groups(ledger, sizes, budget, limit=None, line_counts=None):
    """Next groups of related documents still to review.

    A document larger than the step budget is reviewed in line ranges, one
    range per step. Documents that already failed a step go alone, so one
    hard document cannot block its neighbours twice. A document still partial
    after MAX_PARTIAL_ROUNDS steps without progress stays partial and is
    reported as remaining scope instead of being planned again."""
    line_counts = line_counts or {}
    todo = [path for path, row in sorted(ledger['documents'].items())
            if row['state'] in ('pending', 'partial') and row.get('partialRounds', 0) < MAX_PARTIAL_ROUNDS]
    planned, fresh = [], []
    for path in todo:
        row = ledger['documents'][path]
        tokens = doc_tokens(sizes.get(path, 0))
        lines = line_counts.get(path) or 0
        if tokens > budget['docTokens'] and lines > 1:
            chunk = max(40, int(lines * budget['docTokens'] / tokens))
            next_range = _next_range(row, lines, chunk)
            if next_range:
                planned.append({'documents': [path], 'range': next_range})
        elif row.get('attempts', 0) > 0:
            planned.append({'documents': [path], 'range': None})
        else:
            fresh.append(path)
    groups, current, used, area = [], [], 0, None
    for path in fresh:
        tokens = doc_tokens(sizes.get(path, 0))
        here = posixpath.dirname(path)
        if current and (len(current) >= MAX_GROUP_DOCS or used + tokens > budget['docTokens'] or here != area):
            groups.append({'documents': current, 'range': None})
            current, used = [], 0
        current.append(path)
        used += tokens
        area = here
    if current:
        groups.append({'documents': current, 'range': None})
    retries = [group for group in planned if group['range'] is None]
    ranged = [group for group in planned if group['range'] is not None]
    ordered = retries + groups + ranged
    return ordered[:limit] if limit else ordered


def latest_operator_notes(task):
    notes = [row.get('text', '') for row in task.get('feedback', []) if row.get('by') == 'operator' and row.get('text')]
    return notes[-1][-FEEDBACK_CHARS:] if notes else ''


def group_prompt(ledger, group, output, task, workspace_note, line_range=None):
    if line_range:
        start, end, _ = line_range
        scope_text = (f'Review ONLY lines {start}-{end} of {group[0]}; other steps cover the rest of it. '
                      f'Use state "reviewed" when every claim in lines {start}-{end} is checked.\n')
    else:
        scope_text = ''
    checked = '\n'.join(f'- {path}: {ref["check"]} ({ref["path"]}:{ref["line"]})'
                        for path in group for ref in ledger['documents'][path]['evidence'][-15:]) or '- none'
    related = [f for f in ledger['findings'] if f['document']['path'] in group]
    earlier = '\n'.join(f'- F{f["number"]} ({f["kind"]}, {f["severity"]}) {f["title"]} at {f["document"]["path"]}:{f["document"]["line"]}'
                        for f in related) or '- none'
    partial = '\n'.join(f'- {path}: partial — {ledger["documents"][path].get("note") or "earlier checks recorded"}'
                        for path in group if ledger['documents'][path]['state'] == 'partial') or '- none'
    notes = latest_operator_notes(task)
    return (
        f'You are one step of a documentation review for task {task.get("pipelineId", "")}: {task.get("title", "")}.\n'
        f'{workspace_note}\n\n'
        'Review ONLY these documents against the source code and architecture:\n'
        + '\n'.join(f'- {path}' for path in group) + '\n\n'
        + scope_text + '\n'
        f'Earlier findings for these documents (do not repeat them):\n{earlier}\n\n'
        f'Claims already checked (do not repeat them):\n{checked}\n\n'
        f'Documents partly reviewed before:\n{partial}\n\n'
        'For each document, check its concrete claims (paths, routes, values, names, behaviour) against the source. '
        'Record what you checked as evidence with the exact source path and line. Report a finding only when the '
        'source proves the document wrong (inaccuracy), out of date (obsolete) or missing something important (gap). '
        'Mark a document "partial" if you could not check all of it and say what remains in "note". '
        'Lines are 1-based in the frozen snapshot; the runner verifies every path and line and rejects the whole '
        'result if one is wrong.\n\n'
        f'Write your result as JSON to {output} with exactly this shape:\n{GROUP_SCHEMA}\n'
        'Write the file early with what you have verified, then improve it; stop as soon as it is complete. '
        'Do not edit source files or any other file.\n'
        + (f'\nReviewer notes for the whole task (apply only what concerns these documents):\n{notes}\n' if notes else '')
    )


def legacy_prompt(ledger, output, task, workspace_note):
    return (
        f'You are one step of a documentation review for task {task.get("pipelineId", "")}: {task.get("title", "")}.\n'
        f'{workspace_note}\n\n'
        'An earlier execution wrote the findings below. A reviewer asked for corrections. Apply ONLY the corrections '
        'the reviewer notes require, as exact text replacements, after checking each against the source.\n\n'
        f'Reviewer notes:\n{latest_operator_notes(task) or "(none)"}\n\n'
        f'Earlier findings (verbatim):\n<<<\n{ledger.get("legacy") or ""}\n>>>\n\n'
        f'Write JSON to {output}: {{"legacyEdits": [{{"find": "<exact text that occurs once above>", '
        '"replace": "<corrected text>", "reason": "<which note and what source evidence>"}]}. '
        'Use an empty list if no correction is justified. Stop as soon as the file is written.'
    )


def writer_prompt(ledger, output):
    findings = [{'id': f'F{f["number"]}', 'kind': f['kind'], 'severity': f['severity'], 'title': f['title'],
                 'document': f'{f["document"]["path"]}:{f["document"]["line"]}', 'correction': f['correction'],
                 'evidence': [f'{ref["path"]}:{ref["line"]} {ref["check"]}' for ref in f['evidence'][:3]]}
                for f in ledger['findings']]
    tally = {}
    for row in ledger['documents'].values():
        tally[row['state']] = tally.get(row['state'], 0) + 1
    return (
        'You write the prose of a documentation review report. The runner already verified every finding below and '
        'generates all tables. Write JSON to ' + output + ' shaped {"summary": "<one paragraph: what was reviewed, '
        'the most important problems, what remains>", "explanations": {"F<n>": "<two or three sentences: why it '
        'matters and what a reader would get wrong>"}}. Do not invent findings or numbers; use only these.\n\n'
        f'Coverage: {json.dumps(tally, sort_keys=True)}\nFindings:\n{json.dumps(findings, indent=1)}\n'
        'Stop as soon as the file is written.'
    )


def read_result(path):
    """A bounded JSON object written by the model, or a LedgerError-worthy reason."""
    try:
        if not path.is_file() or path.is_symlink():
            return None, 'no result file was written'
        if path.stat().st_size > RESULT_BYTES:
            return None, f'the result file exceeds {RESULT_BYTES} bytes'
        value = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return None, f'the result file is not valid JSON ({type(error).__name__})'
    if not isinstance(value, dict):
        return None, 'the result must be a JSON object'
    return value, None


def apply_writer(ledger, value):
    summary = value.get('summary')
    if isinstance(summary, str) and summary.strip():
        ledger['summary'] = summary.strip()[:2500]
    explanations = value.get('explanations') or {}
    if isinstance(explanations, dict):
        for finding in ledger['findings']:
            text = explanations.get(f'F{finding["number"]}')
            if isinstance(text, str) and text.strip():
                finding['explanation'] = text.strip()[:1500]


def remaining(progress):
    calls = max(0, progress.call_limit() - progress.model_calls)
    seconds = max(0, int(min(progress.hard_deadline, progress.queue_deadline) - progress.now()))
    return calls, seconds


def write_atomic(path, text):
    temporary = path.with_name(f'.{path.name}.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


# ── Cloud escalation of a failed group (#835) ─────────────────────────────

ESCALATION_SOURCE_CHARS = 360_000     # about 100k tokens of source context
ESCALATION_FILE_CHARS = 60_000
ESCALATION_MAX_TOKENS = 8192
PATH_PATTERN = r'(?<![\w/.-])([\w.-]+(?:/[\w.-]+)+\.(?:js|cjs|mjs|ts|py|json|ya?ml|sh|md|ejs|css|html))'


def referenced_sources(ledger, group, doc_texts, files):
    """Source files a document group cites or already used as evidence, in order."""
    import re
    known = set(files)
    ordered = []
    for path in group:
        for ref in ledger['documents'][path]['evidence']:
            ordered.append(ref['path'])
        ordered += re.findall(PATH_PATTERN, doc_texts.get(path, ''))
    seen, result = set(group), []
    for path in ordered:
        if path in known and path not in seen:
            seen.add(path)
            result.append(path)
    return result


def code_terms(doc_texts, limit=12):
    """Identifiers a document names in code spans or as CONSTANTS, most frequent first."""
    import re
    from collections import Counter
    counts = Counter()
    for text in doc_texts.values():
        for span in re.findall(r'`([^`\n]{3,60})`', text):
            if re.fullmatch(r'[A-Za-z_][\w.:/-]*', span) and '/' not in span:
                counts[span] += 1
        for constant in re.findall(r'\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b', text):
            counts[constant] += 1
    return [term for term, _ in counts.most_common(limit)]


def escalation_prompt(ledger, group, doc_texts, source_texts, line_range=None):
    """One self-contained request: the documents, the sources they cite, the schema."""
    parts = []
    for path in group:
        text = doc_texts.get(path, '')
        if line_range:
            start, end, _ = line_range
            text = '\n'.join(text.splitlines()[start - 1:end])
            parts.append(f'=== DOCUMENT {path} (lines {start}-{end}) ===\n{text}')
        else:
            parts.append(f'=== DOCUMENT {path} ===\n{text}')
    for path, text in source_texts.items():
        numbered = '\n'.join(f'{index}: {line}' for index, line in enumerate(text.splitlines(), 1))
        parts.append(f'=== SOURCE {path} (line numbers prefixed) ===\n{numbered}')
    scope = f' lines {line_range[0]}-{line_range[1]} of' if line_range else ''
    system = ('You verify technical documentation against source code. You receive the documents and the source files '
              'they cite, with line numbers. Answer with ONLY one JSON object, no prose, no code fences.')
    user = ('\n\n'.join(parts) + '\n\n'
            f'Review{scope} the documents above against the sources. Return exactly this JSON shape:\n{GROUP_SCHEMA}\n'
            'Evidence lines must be the line numbers shown above. Report a finding only when a source proves the '
            'document wrong, out of date or missing something important. Mark a document "partial" when the sources '
            'given are not enough to check all of it, and say what is missing in "note".')
    return [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]


def parse_json_object(text):
    """The first JSON object in a model answer, tolerating code fences."""
    body = str(text or '').replace('```json', '').replace('```', '')
    start, end = body.find('{'), body.rfind('}')
    if start < 0 or end <= start:
        return None, 'the answer contains no JSON object'
    try:
        value = json.loads(body[start:end + 1])
    except json.JSONDecodeError:
        return None, 'the answer is not valid JSON'
    return (value, None) if isinstance(value, dict) else (None, 'the answer must be a JSON object')
