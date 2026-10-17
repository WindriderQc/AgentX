"""Runner-owned report ledger (#834).

The model never edits the report. Each step returns a small JSON result for
one group of documents; this module verifies every cited source line against
the frozen snapshot, merges the result into the ledger and renders the
Markdown report and coverage from it, so findings, tables and totals cannot
drift apart. The ledger travels inside the report as an HTML comment, so a
continuation restored from Core's checkpoint resumes it exactly.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re

SCHEMA = 'agentx.report-ledger/v1'
MARKER = re.compile(r'<!-- agentx-report-ledger:v1 ([A-Za-z0-9+/=]+) -->\s*$')
STATES = ('reviewed', 'partial', 'blocked')
KINDS = {'inaccuracy': 'Inaccuracies', 'obsolete': 'Obsolete information', 'gap': 'Gaps'}
SEVERITIES = ('high', 'medium', 'low')
MAX_EVIDENCE = 40
MAX_DOC_EVIDENCE = 100   # Core's coverage contract bound per document
MAX_PARTIAL_ROUNDS = 3
MAX_TEXT = 1200
MAX_FINDINGS_PER_STEP = 30
MAX_LEGACY_EDITS = 30


class LedgerError(ValueError):
    """A step result that cannot be merged; the reason is safe to show the model."""


def _text(value, label, limit=MAX_TEXT, required=True):
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip():
        raise LedgerError(f'{label} must be a nonempty string')
    value = value.strip()
    if len(value) > limit:
        raise LedgerError(f'{label} exceeds {limit} characters')
    return value


def new_ledger(snapshot, coverage=None, legacy_markdown=None):
    """Start a ledger from Core's frozen inventory and any restored coverage."""
    prior = {row['path']: row for row in (coverage or {}).get('documents', []) if isinstance(row, dict)}
    documents = {}
    for row in snapshot['documents']:
        old = prior.get(row['path']) or {}
        documents[row['path']] = {
            'sha256': row['sha256'],
            'state': old.get('state') if old.get('state') in STATES + ('pending',) else 'pending',
            'evidence': list(old.get('evidence') or []),
            'note': None,
            'attempts': 0,
            'ranges': [],
            'partialRounds': 0,
        }
    return {'schema': SCHEMA, 'sourceCommit': snapshot['sourceCommit'], 'inventorySha256': snapshot['sha256'],
            'documents': documents, 'findings': [], 'legacy': legacy_markdown, 'summary': None, 'steps': []}


def embedded(markdown):
    """The ledger embedded in a previously rendered report, or None."""
    match = MARKER.search(markdown or '')
    if not match:
        return None
    value = json.loads(base64.b64decode(match.group(1)).decode('utf-8'))
    if value.get('schema') != SCHEMA:
        raise LedgerError('Embedded report ledger has an unknown schema')
    return value


def legacy_narrative(markdown):
    """Keep an earlier free-form report up to its own coverage/summary tables.

    Those tables are regenerated from the ledger; findings and notes before
    them are preserved verbatim as earlier work."""
    lines = (markdown or '').splitlines()
    for index, line in enumerate(lines):
        if index and re.match(r'^#{1,3}\s.*(coverage|summary|validation)', line, re.IGNORECASE):
            return '\n'.join(lines[:index]).strip()
    return '\n'.join(lines).strip()


def _evidence(refs, source_bytes, label):
    if not isinstance(refs, list) or len(refs) > MAX_EVIDENCE:
        raise LedgerError(f'{label} needs a list of at most {MAX_EVIDENCE} source references')
    checked = []
    for ref in refs:
        if not isinstance(ref, dict):
            raise LedgerError(f'{label} references must be objects with path, line and check')
        path = _text(ref.get('path'), f'{label} path', 300)
        line = ref.get('line')
        try:
            data = source_bytes(path)
        except ValueError as error:
            raise LedgerError(f'{label}: {path} is not in the frozen snapshot') from error
        lines = data.splitlines()
        if type(line) is not int or not 1 <= line <= len(lines):
            raise LedgerError(f'{label}: line {line!r} is outside {path} (1-{len(lines)})')
        checked.append({'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'line': line,
                        'check': _text(ref.get('check'), f'{label} check')})
    return checked


def merge_step(ledger, group, result, source_bytes, step_id, allow_empty=False, line_range=None):
    """Verify one step result for `group` (document paths) and merge it.

    With `line_range` (start, end, last) the group is one large document and
    the step covered only those lines: the document becomes reviewed once
    every range is. Evidence is added to what earlier steps recorded.
    Returns a short receipt. Raises LedgerError, merging nothing, when any
    part is invalid: a step is accepted whole or not at all."""
    if not isinstance(result, dict):
        raise LedgerError('The result must be a JSON object')
    rows = result.get('documents')
    if not isinstance(rows, list) or (not rows and not allow_empty):
        raise LedgerError('documents must list the group documents you checked')
    updates = {}
    for row in rows:
        path = row.get('path') if isinstance(row, dict) else None
        if path not in group:
            raise LedgerError(f'{path!r} is not a document of this group')
        state = row.get('state')
        if state not in STATES:
            raise LedgerError(f'{path}: state must be one of {", ".join(STATES)}')
        evidence = _evidence(row.get('evidence', []), source_bytes, path)
        if state == 'reviewed' and not evidence:
            raise LedgerError(f'{path}: a reviewed document needs source evidence')
        updates[path] = {'state': state, 'evidence': evidence,
                         'note': _text(row.get('note'), f'{path} note', 600, required=False)}
    findings = result.get('findings', [])
    if not isinstance(findings, list) or len(findings) > MAX_FINDINGS_PER_STEP:
        raise LedgerError(f'findings must be a list of at most {MAX_FINDINGS_PER_STEP}')
    accepted = []
    for index, finding in enumerate(findings):
        if not isinstance(finding, dict):
            raise LedgerError('Each finding must be an object')
        label = f'finding {index + 1}'
        kind = finding.get('kind')
        if kind not in KINDS:
            raise LedgerError(f'{label}: kind must be one of {", ".join(KINDS)}')
        severity = finding.get('severity')
        if severity not in SEVERITIES:
            raise LedgerError(f'{label}: severity must be one of {", ".join(SEVERITIES)}')
        document = finding.get('document') or {}
        if document.get('path') not in group:
            raise LedgerError(f'{label}: document.path must be a document of this group')
        [doc_ref] = _evidence([{**document, 'check': 'documented claim'}], source_bytes, label)
        evidence = _evidence(finding.get('evidence', []), source_bytes, label)
        if not evidence:
            raise LedgerError(f'{label}: needs source evidence proving it')
        accepted.append({'kind': kind, 'severity': severity, 'title': _text(finding.get('title'), f'{label} title', 200),
                         'document': {'path': doc_ref['path'], 'line': doc_ref['line']}, 'evidence': evidence,
                         'correction': _text(finding.get('correction'), f'{label} correction'), 'step': step_id})
    edits = result.get('legacyEdits', [])
    if edits and not ledger.get('legacy'):
        raise LedgerError('legacyEdits apply only to a report with earlier findings')
    if not isinstance(edits, list) or len(edits) > MAX_LEGACY_EDITS:
        raise LedgerError(f'legacyEdits must be a list of at most {MAX_LEGACY_EDITS}')
    legacy = ledger.get('legacy')
    for index, edit in enumerate(edits):
        find = _text((edit or {}).get('find'), f'legacy edit {index + 1} find', 2000)
        replace = (edit or {}).get('replace')
        if not isinstance(replace, str) or len(replace) > 4000:
            raise LedgerError(f'legacy edit {index + 1}: replace must be text of at most 4000 characters')
        if legacy.count(find) != 1:
            raise LedgerError(f'legacy edit {index + 1}: the exact text to replace must occur once (found {legacy.count(find)})')
        legacy = legacy.replace(find, replace, 1)

    for path, update in updates.items():
        row = ledger['documents'][path]
        seen = {(ref['path'], ref['line'], ref['check']) for ref in row['evidence']}
        added = [ref for ref in update['evidence'] if (ref['path'], ref['line'], ref['check']) not in seen]
        row['evidence'] = (row['evidence'] + added)[-MAX_DOC_EVIDENCE:]
        if update['note']:
            row['note'] = update['note']
        state = update['state']
        if line_range and state == 'reviewed':
            start, end, last = line_range
            row.setdefault('ranges', []).append([start, end])
            state = 'reviewed' if last else 'partial'
        elif line_range and state == 'partial':
            row['partialRounds'] = row.get('partialRounds', 0) + 1
        elif state == 'partial':
            # A document still partial after a step with nothing new counts
            # toward its limit, so it cannot be planned forever.
            row['partialRounds'] = row.get('partialRounds', 0) + (0 if added else 1)
        row['state'] = state
    for path in group:
        ledger['documents'][path]['attempts'] = 0
    base = 1 + max([0] + [int(m) for m in re.findall(r'\bF(\d+)\b', ledger.get('legacy') or '')]
                   + [finding['number'] for finding in ledger['findings']])
    for offset, finding in enumerate(accepted):
        ledger['findings'].append({**finding, 'number': base + offset})
    ledger['legacy'] = legacy
    receipt = {'step': step_id, 'documents': sorted(updates), 'findings': len(accepted), 'legacyEdits': len(edits)}
    ledger['steps'].append({**receipt, 'result': 'merged'})
    return receipt


def record_failure(ledger, group, step_id, reason, max_attempts=2):
    """A step that produced nothing usable; after `max_attempts`, block its documents."""
    blocked = []
    for path in group:
        document = ledger['documents'][path]
        document['attempts'] = document.get('attempts', 0) + 1
        if document['attempts'] >= max_attempts and document['state'] in ('pending', 'partial'):
            document['state'] = 'blocked'
            document['note'] = f'Blocked after {document["attempts"]} attempts: {reason}'[:600]
            blocked.append(path)
    ledger['steps'].append({'step': step_id, 'documents': sorted(group), 'result': 'failed', 'reason': reason[:300],
                            'blocked': blocked})
    return blocked


def counts(ledger):
    tally = {'reviewed': 0, 'partial': 0, 'blocked': 0, 'pending': 0}
    for document in ledger['documents'].values():
        tally[document['state'] if document['state'] in tally else 'pending'] += 1
    return tally


def coverage(ledger):
    """coverage.json in the shape Core's report contract validates."""
    tally = counts(ledger)
    return {'inventorySha256': ledger['inventorySha256'],
            'documents': [{'path': path, 'sha256': row['sha256'], 'state': row['state'], 'evidence': row['evidence']}
                          for path, row in sorted(ledger['documents'].items())],
            'declaredComplete': tally['reviewed'] == len(ledger['documents']),
            'acceptance': 'independent_review_required'}


def _cell(value):
    return str(value).replace('|', '\\|').replace('\n', ' ')


def render(ledger, title, next_groups=()):
    """The Markdown report, generated entirely from the ledger."""
    tally = counts(ledger)
    total = len(ledger['documents'])
    findings = ledger['findings']
    out = [f'# {title}', '',
           f'Source snapshot `{ledger["sourceCommit"]}` · {total} documents in the frozen inventory. '
           'Structure, tables and totals are generated by the AgentX runner from a verified ledger; every cited '
           'source line was checked against the snapshot.', '', '## Summary', '']
    if ledger.get('summary'):
        out += [ledger['summary'], '']
    out += ['| Reviewed | Partial | Blocked | Pending | New findings |', '|---|---|---|---|---|',
            f'| {tally["reviewed"]} | {tally["partial"]} | {tally["blocked"]} | {tally["pending"]} | {len(findings)} |', '']
    if findings:
        out += ['## Findings', '']
        for kind, heading in KINDS.items():
            group = [f for f in findings if f['kind'] == kind]
            if not group:
                continue
            out += [f'### {heading}', '']
            for finding in sorted(group, key=lambda f: (SEVERITIES.index(f['severity']), f['number'])):
                out += [f'#### F{finding["number"]} — {finding["title"]} *({finding["severity"]})*', '',
                        f'- Document: `{finding["document"]["path"]}:{finding["document"]["line"]}`']
                out += [f'- Evidence: `{ref["path"]}:{ref["line"]}` — {ref["check"]}' for ref in finding['evidence']]
                out += [f'- Correction: {finding["correction"]}']
                if finding.get('escalatedModel'):
                    out += [f'- Found by cloud escalation on `{finding["escalatedModel"]}` after the local model failed this group.']
                if finding.get('explanation'):
                    out += ['', finding['explanation']]
                out += ['']
    if ledger.get('legacy'):
        out += ['## Findings from earlier executions (preserved)', '',
                'Kept verbatim from earlier runs, with only the corrections recorded in the ledger applied.', '',
                re.sub(r'^(#{1,4})\s', lambda m: '#' * min(6, len(m.group(1)) + 2) + ' ', ledger['legacy'], flags=re.M), '']
    out += ['## Coverage', '', '| Document | State | Evidence checked |', '|---|---|---|']
    for path, row in sorted(ledger['documents'].items()):
        checks = '; '.join(f'`{ref["path"]}:{ref["line"]}` {ref["check"]}' for ref in row['evidence'][:4])
        if len(row['evidence']) > 4:
            checks += f'; and {len(row["evidence"]) - 4} more'
        if row.get('note'):
            checks = f'{checks} — {row["note"]}' if checks else row['note']
        out += [f'| `{_cell(path)}` | {row["state"]} | {_cell(checks) or "—"} |']
    out += ['', '## Remaining scope', '']
    remaining = [path for path, row in sorted(ledger['documents'].items()) if row['state'] != 'reviewed']
    if not remaining:
        out += ['Every document in the inventory is reviewed. The report still needs independent review before acceptance.']
    else:
        out += [f'{len(remaining)} documents are not fully reviewed.', '']
        for index, group in enumerate(next_groups, 1):
            out += [f'- Next group {index}: ' + ', '.join(f'`{path}`' for path in group)]
    blob = base64.b64encode(json.dumps(ledger, sort_keys=True, separators=(',', ':')).encode('utf-8')).decode('ascii')
    out += ['', f'<!-- agentx-report-ledger:v1 {blob} -->', '']
    return '\n'.join(out)
