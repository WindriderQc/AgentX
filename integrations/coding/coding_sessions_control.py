#!/usr/bin/env python3
"""Exact-request native session transport for Core; never launches a worker."""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


control = load('coding_dispatch_control')
history = load('coding_opencode_history')


def execute(action, pipeline_id, request_id, executor_id, *args):
    if (not re.fullmatch(r'\d{4}', pipeline_id) or not history.UUID.fullmatch(request_id)
            or not control.EXECUTOR_ID.fullmatch(executor_id)):
        raise history.SessionError('Exact task, request and executor identities are required', status=400)
    run = control.read_receipt(request_id)
    if not run or run.get('pipelineId') != pipeline_id or run.get('requestId') != request_id:
        raise history.SessionError('The native receipt does not belong to this Core request')
    if run.get('executorId') and run['executorId'] != executor_id:
        raise history.SessionError('The native receipt belongs to another executor')
    if action == 'list' and not args:
        return {'pipelineId': pipeline_id, 'requestId': request_id, 'executorId': executor_id,
            'sessions': [history.public_binding(value) for value in history.bindings(control.RECEIPTS, pipeline_id, request_id)]}
    if not args or not history.UUID.fullmatch(args[0]):
        raise history.SessionError('An exact worker invocation is required', status=400)
    value = history.select(control.RECEIPTS, pipeline_id, request_id, args[0])
    if action == 'read' and len(args) == 3:
        if not re.fullmatch(r'\d{1,5}', args[1]) or args[2] != '-' and not re.fullmatch(r'[a-f0-9]{64}', args[2]):
            raise history.SessionError('Invalid native history page', status=400)
        data = history.read(value, offset=int(args[1]), expected_revision=None if args[2] == '-' else args[2])
        configured = all(control.setting(key) for key in ('AGENTX_OPENCODE_HANDOFF_ROOT',
            'AGENTX_OPENCODE_HUMAN_HOME', 'AGENTX_OPENCODE_HUMAN_URL', 'AGENTX_OPENCODE_ROOT'))
        return {**data, 'canHandoff': data['canHandoff'] and configured,
            'handoffConfigured': configured, 'executorId': executor_id}
    if action == 'handoff' and len(args) == 3:
        handoffs = load('coding_opencode_handoff')
        root = control.setting('AGENTX_OPENCODE_HANDOFF_ROOT')
        human_home = control.setting('AGENTX_OPENCODE_HUMAN_HOME')
        origin = control.setting('AGENTX_OPENCODE_HUMAN_URL')
        runtime = control.setting('AGENTX_OPENCODE_ROOT')
        entry = control.setting('AGENTX_OPENCODE_ENTRY', 'bin/opencode')
        if (not all((root, human_home, origin, runtime)) or not re.fullmatch(r'[A-Za-z0-9._/-]+', entry)
                or Path(entry).is_absolute() or '..' in Path(entry).parts):
            raise history.SessionError('The independent human OpenCode runtime is not configured', status=503)
        return {**handoffs.handoff(value, args[1], args[2], state_root=Path(root),
            human_home=Path(human_home), binary=Path(runtime) / entry, origin=origin,
            node_bin=control.setting('AGENTX_NODE_BIN', 'node')), 'executorId': executor_id}
    raise history.SessionError('Invalid native session operation', status=400)


def main():
    try:
        if len(sys.argv) < 5:
            raise history.SessionError('An exact native session operation is required', status=400)
        result = execute(*sys.argv[1:])
        print(json.dumps({'status': 'success', 'data': result}, ensure_ascii=False))
    except Exception as error:
        # Do not reflect raw SQLite, filesystem, transcript or subprocess errors.
        known = hasattr(error, 'code') and hasattr(error, 'status')
        print(json.dumps({'status': 'error', 'code': error.code if known else 'CODING_SESSION_UNAVAILABLE',
            'statusCode': error.status if known else 503,
            'message': str(error) if known else 'The native session could not be read; retain the original request.'}))


if __name__ == '__main__':
    main()
