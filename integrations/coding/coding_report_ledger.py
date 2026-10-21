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


def _evidence(refs, source_bytes, label, *, limit=MAX_EVIDENCE):
    if not isinstance(refs, list) or len(refs) > limit:
        raise LedgerError(f'{label} needs a list of at most {limit} source references')
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
        evidence = _evidence(row.get('evidence', []), source_bytes, path, limit=MAX_DOC_EVIDENCE)
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
        if not isinstance(edit, dict):
            raise LedgerError(f'legacy edit {index + 1} must be an object')
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


def legacy_review_required(ledger, notes, *, review_evidence=False):
    """A historical boolean cannot prove that these reviewer notes were applied."""
    if not notes or not (ledger.get('legacy') or review_evidence):
        return False
    review = ledger.get('legacyReview') or {}
    return not (review.get('result') == 'merged'
                and review.get('sourceCommit') == ledger['sourceCommit']
                and review.get('inventorySha256') == ledger['inventorySha256']
                and review.get('notesSha256') == hashlib.sha256(notes.encode()).hexdigest()
                and review.get('legacySha256') == hashlib.sha256((ledger.get('legacy') or '').encode()).hexdigest()
                and all(any(ref.get('path') == edit['path'] and ref.get('line') == edit['line']
                            and ref.get('sha256') == edit['sha256'] and ref.get('check') == edit['after']
                            for ref in ledger['documents'].get(edit['document'], {}).get('evidence', []))
                        for edit in review.get('evidenceCorrections', [])))


def continuation_retries(ledger, request_id, parent_request_id):
    """Give an explicitly authorized new execution its bounded local attempts.

    Native/Core authority is checked before the restored ledger reaches here.
    Preserve every failed step and reviewed range; this grants no model calls.
    """
    if not parent_request_id or request_id == parent_request_id or ledger.get('continuationRequestId') == request_id:
        return
    resets = []
    for path, row in ledger['documents'].items():
        if row['state'] not in ('blocked', 'partial', 'pending') or not (row.get('attempts') or row.get('partialRounds')):
            continue
        resets.append({'path': path, **{key: row.get(key) for key in ('state', 'attempts', 'partialRounds', 'note')}})
        if row['state'] == 'blocked':
            row['state'] = 'partial' if row['evidence'] else 'pending'
        row['attempts'], row['partialRounds'] = 0, 0
        row['note'] = ('An authorized continuation permits another bounded attempt. Earlier stop: ' + (row.get('note') or 'no usable step result'))[:600]
    ledger['continuationRequestId'] = request_id
    if resets:
        ledger['steps'].append({'step': 0, 'kind': 'continuation', 'requestId': request_id,
                                'parentRequestId': parent_request_id, 'result': 'retry_authorized',
                                'documents': [row['path'] for row in resets], 'previous': resets})


def evidence_corrections(ledger, edits, source_bytes):
    """Stage exact corrections to existing proof text without changing coverage."""
    if not isinstance(edits, list) or len(edits) > MAX_LEGACY_EDITS:
        raise LedgerError(f'evidenceEdits must be a list of at most {MAX_LEGACY_EDITS}')
    staged, targets = [], set()
    for edit in edits:
        if (not isinstance(edit, dict) or not isinstance(edit.get('document'), str)
                or edit['document'] not in ledger['documents']):
            raise LedgerError('each evidence edit must identify an original inventory document')
        if not set(edit) <= {'document', 'path', 'line', 'find', 'replace'}:
            raise LedgerError('an evidence edit cannot change coverage or source references')
        path, line = edit.get('path'), edit.get('line')
        if not isinstance(path, str) or type(line) is not int:
            raise LedgerError('each evidence edit needs its original source line')
        find = _text(edit.get('find'), 'evidence edit find')
        replace = _text(edit.get('replace'), 'evidence edit replace')
        key = (edit['document'], path, line, find)
        if key in targets:
            raise LedgerError('an evidence edit target must occur only once')
        targets.add(key)
        matches = [ref for ref in ledger['documents'][edit['document']]['evidence']
                   if ref['path'] == path and ref['line'] == line and ref['check'] == find]
        if len(matches) != 1:
            raise LedgerError('the original evidence text must match exactly once')
        [verified] = _evidence([{'path': path, 'line': line, 'check': replace}], source_bytes, 'evidence correction')
        if matches[0]['sha256'] != verified['sha256']:
            raise LedgerError('the original evidence does not match the frozen source')
        staged.append((matches[0], replace, {'document': edit['document'], 'path': path, 'line': line,
            'sha256': verified['sha256'], 'before': find, 'after': replace}))
    return staged


def document_rechecks(ledger, paths, notes, source_bytes):
    """Stage source-bound coverage withdrawals requested by new reviewer notes."""
    if not isinstance(paths, list) or len(paths) > MAX_LEGACY_EDITS:
        raise LedgerError(f'recheckDocuments must be a list of at most {MAX_LEGACY_EDITS}')
    prior = ledger.get('legacyReview') or {}
    if paths and (not isinstance(notes, str) or not notes.strip() or (prior.get('result') == 'merged'
            and prior.get('notesSha256') == hashlib.sha256(notes.encode()).hexdigest())):
        raise LedgerError('document rechecks require new reviewer notes')
    staged, seen = [], set()
    for path in paths:
        if not isinstance(path, str) or path not in ledger['documents'] or path in seen:
            raise LedgerError('each recheck must name a distinct original inventory document')
        seen.add(path)
        row = ledger['documents'][path]
        if row['state'] != 'reviewed':
            raise LedgerError('only a reviewed document needs reopening')
        if hashlib.sha256(source_bytes(path)).hexdigest() != row['sha256']:
            raise LedgerError('the rechecked document does not match the frozen source')
        staged.append((row, {'path': path, 'sha256': row['sha256'], 'previous': {
            key: row.get(key) for key in ('state', 'note', 'ranges', 'attempts', 'partialRounds')}}))
    return staged


def merge_legacy_review(ledger, value, reason, notes, source_bytes, step_id, request_id):
    """Record a failed correction step durably, and acknowledge only valid results."""
    before = hashlib.sha256((ledger.get('legacy') or '').encode()).hexdigest()
    try:
        if value is None:
            raise LedgerError(reason or 'no correction result was written')
        if (not isinstance(value, dict) or not set(value) <= {'legacyEdits', 'evidenceEdits', 'recheckDocuments'}
                or not isinstance(value.get('legacyEdits'), list)):
            raise LedgerError('the correction result must contain a legacyEdits list')
        staged = evidence_corrections(ledger, value.get('evidenceEdits', []), source_bytes)
        rechecks = document_rechecks(ledger, value.get('recheckDocuments', []), notes, source_bytes)
        merge_step(ledger, [], {'legacyEdits': value['legacyEdits'], 'documents': []}, source_bytes, step_id, allow_empty=True)
        for ref, replace, _ in staged:
            ref['check'] = replace
        if staged:
            ledger['steps'][-1]['evidenceCorrections'] = [receipt for _, _, receipt in staged]
        for row, _ in rechecks:
            row.update(state='partial', ranges=[], attempts=0, partialRounds=0)
        if rechecks:
            ledger['steps'][-1]['recheckedDocuments'] = [receipt for _, receipt in rechecks]
    except LedgerError as error:
        record_failure(ledger, [], step_id, str(error))
    receipt = ledger['steps'][-1]
    receipt.update(kind='legacy', requestId=request_id, sourceCommit=ledger['sourceCommit'],
                   inventorySha256=ledger['inventorySha256'], legacyBeforeSha256=before,
                   notesSha256=hashlib.sha256(notes.encode()).hexdigest())
    ledger['legacyReview'] = {**receipt, 'legacySha256': hashlib.sha256((ledger.get('legacy') or '').encode()).hexdigest()}
    ledger['legacyReviewed'] = receipt['result'] == 'merged'
    ledger['legacyReviewPending'] = not ledger['legacyReviewed']


def progress_marker(ledger):
    """Material verified scope, excluding prose-only notes and runner receipts."""
    documents = ledger['documents']
    return {'reviewed': frozenset(path for path, row in documents.items() if row['state'] == 'reviewed'),
            'evidence': frozenset((path, ref['path'], ref['sha256'], ref['line'])
                for path, row in documents.items() for ref in row['evidence']),
            'ranges': frozenset((path, start, end) for path, row in documents.items()
                for start, end in row.get('ranges', [])),
            'findings': frozenset((row['kind'], row['document']['path'], row['document']['line'],
                tuple(sorted({(ref['path'], ref['sha256'], ref['line']) for ref in row['evidence']})))
                for row in ledger.get('findings', [])),
            'legacy': frozenset((hashlib.sha256((ledger.get('legacy') or '').encode()).hexdigest(),))}


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
            'declaredComplete': tally['reviewed'] == len(ledger['documents']) and not ledger.get('legacyReviewPending'),
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
    if ledger.get('legacyReviewPending'):
        out += ['Reviewer corrections to the earlier findings remain pending.', '']
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
    if ledger.get('legacyReviewPending'):
        out += ['Apply the outstanding reviewer corrections to the earlier findings before completion.', '']
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
