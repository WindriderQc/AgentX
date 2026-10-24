"""One runner-owned step for an already reviewed, small source/test pair."""
from __future__ import annotations

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAX_PAIR_BYTES = 64 * 1024


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


steps = load('coding_code_steps')
verification = load('coding_verification')


def build(workspace, manifest, capability=None):
    """Return a validated plan or defer to the existing bounded planner.

    This chooses no extra paths, commands, permissions or budget. The native
    verifier still owns focused/full tests, commits and publication.
    """
    scope = manifest.get('scope')
    reviewed = manifest.get('qualification') or {}
    budget = steps.step_budget(capability)
    if (not isinstance(scope, list) or len(scope) != 2
            or not isinstance(reviewed, dict) or not reviewed.get('acceptanceCriteria')
            or budget['maxFilesPerStep'] < 2):
        return None
    clean = [steps.repository_path(path) for path in scope]
    if len(set(clean)) != 2:
        return None
    root = Path(workspace).resolve()
    sizes = []
    targets = []
    for path in clean:
        source = root / path
        if not source.is_file() or source.resolve() != source:
            return None
        sizes.append(source.stat().st_size)
        name = source.name
        if ((source.suffix == '.py' and name.startswith('test_'))
                or name.endswith('.test.js')):
            try:
                verification.focused_command(root, manifest.get('verificationProfile'), [path])
            except verification.VerificationError:
                return None
            targets.append(path)
    if len(targets) != 1 or sum(sizes) > MAX_PAIR_BYTES:
        return None
    source = next(path for path in clean if path not in targets)
    if Path(source).suffix not in {'.py', '.js', '.cjs'}:
        return None
    return steps.validate_plan({
        'schema': steps.PLAN_SCHEMA,
        'summary': 'One reviewed source and test change within the exact task scope.',
        'steps': [{
            'id': 'step-01',
            'title': 'Implement the reviewed source and regression test together',
            'objective': 'Implement the task and its regression tests as one passing change. '
                         'Preserve unrelated behavior and edit only the reviewed pair.',
            'paths': clean, 'testTargets': targets, 'dependsOn': [],
        }],
    }, clean, capability)
