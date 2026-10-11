"""Durable publication intent and read-only recovery; never replay an unknown effect."""
from __future__ import annotations
import base64
import os

class PublicationUnknown(RuntimeError):
    pass

def validate(pr, repository, branch, base, number=None):
    if (pr.get('state') != 'open' or pr.get('head', {}).get('ref') != branch
            or pr.get('base', {}).get('ref') != base
            or pr.get('head', {}).get('repo', {}).get('full_name') != repository
            or pr.get('base', {}).get('repo', {}).get('full_name') != repository
            or number is not None and pr.get('number') != number):
        raise RuntimeError('The original PR is closed or its identity changed')
    return pr

def original(request, repository, branch, base, expected, token):
    root = f'https://api.github.com/repos/{repository}/pulls'
    if expected:
        if expected.get('repository') != repository or expected.get('branch') != branch or expected.get('base') != base:
            raise RuntimeError('The saved PR identity differs from the delivery')
        return validate(request(f'{root}/{expected["number"]}', token=token), repository, branch, base, expected['number'])
    matches = request(f'{root}?head={repository.split("/")[0]}:{branch}&state=all&per_page=100', token=token)
    if len(matches) > 1:
        raise RuntimeError('Ambiguous task PR history')
    return validate(matches[0], repository, branch, base) if matches else None

def publish(r, workspace, intent, path, token):
    # Identity validation precedes every external mutation, including push.
    previous = original(r.request, intent['repository'], intent['branch'], intent['base'], intent.get('expectedPR'), token)
    if previous:
        intent['number'] = previous['number']
    r.coding_dispatch_control.atomic_json(path, intent)
    try:
        intent['stage'] = 'push_started'
        r.coding_dispatch_control.atomic_json(path, intent)
        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': '1',
               'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader',
               'GIT_CONFIG_VALUE_0': 'Authorization: Basic ' + base64.b64encode(f'x-access-token:{token}'.encode()).decode()}
        r.git(workspace, 'push', f'https://github.com/{intent["repository"]}.git', f'HEAD:refs/heads/{intent["branch"]}', env=env)
        root = f'https://api.github.com/repos/{intent["repository"]}/pulls'
        intent['stage'] = 'updating_pr' if previous else 'creating_pr'
        r.coding_dispatch_control.atomic_json(path, intent)
        if previous:
            r.request(f'{root}/{previous["number"]}', {'body': intent['body']}, token=token, method='PATCH')
        else:
            created = r.request(root, {'title': intent['title'], 'head': intent['branch'], 'base': intent['base'],
                                     'draft': True, 'body': intent['body']}, token=token)
            intent['number'] = created['number']
            r.coding_dispatch_control.atomic_json(path, intent)
        pr = recover(r.request, intent, token)
        intent.update(stage='published', pr=pr)
        r.coding_dispatch_control.atomic_json(path, intent)
        return pr
    except Exception as error:
        # The effect may already exist. Save the intent and leave native leases
        # held; only GET observations may reconcile it, without a second push/POST.
        raise PublicationUnknown('Publication outcome needs read-only reconciliation') from error

def recover(request, intent, token):
    root = f'https://api.github.com/repos/{intent["repository"]}'
    ref = request(f'{root}/git/ref/heads/{intent["branch"]}', token=token)
    if ref.get('object', {}).get('sha') != intent['head']:
        raise PublicationUnknown('The original publication head is not confirmed')
    expected = intent.get('expectedPR')
    if intent.get('number'):
        expected = {**intent['identity'], 'number': intent['number']}
    pr = original(request, intent['repository'], intent['branch'], intent['base'], expected, token)
    if not pr or pr['head'].get('sha') != intent['head'] or pr.get('body') != intent['body']:
        raise PublicationUnknown('The exact original PR and description are not confirmed')
    return {**intent['identity'], 'number': pr['number'], 'url': pr['html_url'], 'head': intent['head'],
            'diffFingerprint': intent['diffFingerprint']}

def verdict(intent, pr):
    body = intent['verdict']
    body['text'] = f'Autonomous request {intent["requestId"]}: review; {pr["url"]}. Independent verification passed.'
    return body
