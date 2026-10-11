"""Bounded exact-commit observations; external output is evidence, never commands."""
from __future__ import annotations
import re
from urllib.request import Request, build_opener, HTTPRedirectHandler, urlopen
from urllib.error import HTTPError
from urllib.parse import urlparse

STATES = {'success': 'success', 'failure': 'failure', 'cancelled': 'cancelled',
          'timed_out': 'timeout', 'action_required': 'failure', 'startup_failure': 'failure',
          'neutral': 'not_executed', 'skipped': 'not_executed', 'stale': 'not_executed'}
def observe(request, repository, task_id, expected, token):
    if task_id == '0909' or expected.get('branch') != f'agentx/coding-task-{task_id}' or expected.get('base') != 'main':
        raise RuntimeError('Unapproved PR identity')
    number = expected.get('number')
    if type(number) is not int or not 1 <= number <= 1000000:
        raise RuntimeError('Invalid PR number')
    origin = f'https://api.github.com/repos/{repository}'
    pr = request(f'{origin}/pulls/{number}', token=token)
    if pr['head']['ref'] != expected['branch'] or pr['base']['ref'] != expected['base'] or pr['head']['repo']['full_name'] != repository:
        raise RuntimeError('PR branch, repository or target changed')
    head = pr['head']['sha']
    if not re.fullmatch('[a-f0-9]{40}', head):
        raise RuntimeError('Invalid GitHub head')
    result = request(f'{origin}/commits/{head}/check-runs?per_page=100', token=token)
    if result.get('total_count', 0) > 100:
        raise RuntimeError('CI observation exceeds the bounded check budget')
    checks = []
    # GitHub may retain reruns. Only the newest record for a name is a verdict.
    latest = {}
    for check in result.get('check_runs', []):
        name = str(check.get('name', ''))[:160]
        if name not in latest or check['id'] > latest[name]['id']:
            latest[name] = check
    diagnostic_budget = 4
    coverage_budget = 5
    for name, check in sorted(latest.items()):
        failed = check.get('conclusion') in {'failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'}
        detail = diagnostics(request, origin, check, token) if failed and diagnostic_budget > 0 else []
        if failed:
            diagnostic_budget -= 1
            if not detail:
                detail = ['No bounded diagnostic available; inspect the linked CI check.']
        coverage = check_coverage(request, origin, check, token) if coverage_budget > 0 else 'coverage read budget exceeded'
        coverage_budget -= 1
        checks.append({'name': name, 'head': check.get('head_sha'), 'coverage': coverage,
                       'state': STATES.get(check.get('conclusion'), 'pending'),
                       'diagnostics': detail,
                       'url': check.get('html_url') if str(check.get('html_url', '')).startswith('https://github.com/') else None})
    return {'head': head, 'baseHead': pr['base']['sha'], 'number': number,
            'state': pr['state'], 'merged': pr.get('merged', False),
            'mergeable': 'conflict' if pr.get('mergeable') is False else 'clean' if pr.get('mergeable') is True else 'unknown',
            'checks': checks, 'coverage': 'check-runs; unconfigured checks and native product acceptance remain unverified'}


def clean(value, maximum=1600):
    text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', str(value or ''))
    text = re.sub(r'\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9]+)\b', '[redacted]', text)
    text = re.sub(r'(?i)(authorization|password|api[_-]?key|token)\s*[:=]\s*\S+', r'\1=[redacted]', text)
    return text[-maximum:]

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def job_log(origin, job_id, token):
    # GitHub's signed log redirect receives no credentials. Bound bytes/time;
    # logs stay private evidence and never enter the public PR description.
    req = Request(f'{origin}/actions/jobs/{job_id}/logs', headers={'Authorization': f'Bearer {token}'})
    try:
        response = build_opener(NoRedirect).open(req, timeout=5)
    except HTTPError as error:
        if error.code not in {302, 307}:
            raise
        target = error.headers.get('Location', '')
        parsed = urlparse(target)
        if parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith(('.githubusercontent.com', '.blob.core.windows.net')):
            raise RuntimeError('Unapproved log redirect')
        response = urlopen(target, timeout=5)
    with response:
        raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        return 'CI log exceeds the bounded read budget; inspect the linked job.'
    lines = raw.decode(errors='replace').splitlines()
    failures = [line for line in lines if re.search(r'FAIL|Error:|AssertionError|Expected:|Received:|●|FAILED', line)]
    return clean('\n'.join(failures[-12:] or lines[-12:]), 2000)

def diagnostics(request, origin, check, token):
    output = check.get('output') or {}
    entries = [clean(output.get('summary')), clean(output.get('text'))]
    if output.get('annotations_count'):
        annotations = request(f'{origin}/check-runs/{check["id"]}/annotations?per_page=20', token=token)
        entries.extend(clean(f'{item.get("path")}:{item.get("start_line")}: {item.get("message")}', 400) for item in annotations[:10])
    # Native check summaries may omit the failing test. Actions logs provide a
    # bounded diagnostic, labelled untrusted by the runner prompt.
    job = re.search(r'/actions/runs/\d+/job/(\d+)', str(check.get('details_url') or check.get('html_url') or ''))
    if job:
        try:
            entries.append(job_log(origin, job.group(1), token))
        except Exception:
            entries.append('Job log unavailable; inspect the linked CI check.')
    return [entry for entry in entries if entry][:12]


def check_coverage(request, origin, check, token):
    job = re.search(r'/actions/runs/\d+/job/(\d+)', str(check.get('details_url') or check.get('html_url') or ''))
    if not job:
        return 'execution coverage unverified'
    try:
        result = request(f'{origin}/actions/jobs/{job.group(1)}', token=token)
        steps = [step for step in result.get('steps', []) if re.search(r'test|unittest|pytest|smoke|Compose renders|Scripts parse|round trip', str(step.get('name', '')), re.I)]
        if not steps:
            return 'no verification steps reported'
        performed = sum(step.get('conclusion') == 'success' for step in steps)
        skipped = sum(step.get('conclusion') == 'skipped' for step in steps)
        return f'{performed} verification steps succeeded; {skipped} skipped/out of scope; {len(steps) - performed - skipped} pending/failed'
    except Exception:
        return 'execution coverage unavailable; check status alone is not product acceptance'
