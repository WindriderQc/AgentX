"""Runner-owned verification commands for bounded coding steps."""
from __future__ import annotations

from pathlib import Path, PurePosixPath


FULL_COMMANDS = {
    'agentx-dispatcher-tests/v1': ['python3', '-m', 'unittest', 'discover', '-s', 'integrations/coding/tests'],
    'agentx-benchmark-artifact-tests/v1': ['/opt/node/bin/node', 'benchmark/node_modules/jest/bin/jest.js',
                                           '--config', '/opt/coding/jest.benchmark.config.cjs', '--runInBand'],
    'agentx-core-runner-tests/v1': ['/opt/node/bin/node', 'core/node_modules/jest/bin/jest.js',
                                    '--config', 'core/jest.coding.config.js', '--runInBand'],
}

ROOTS = {
    'agentx-dispatcher-tests/v1': ('integrations/coding/tests', '.py'),
    'agentx-benchmark-artifact-tests/v1': ('benchmark', '.js'),
    'agentx-core-runner-tests/v1': ('core', '.js'),
}


class VerificationError(ValueError):
    pass


def full_command(profile: str) -> list[str]:
    command = FULL_COMMANDS.get(profile)
    if not command:
        raise VerificationError('No installed independent verification profile')
    return list(command)


def _target(workspace: Path, profile: str, value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 240 or '\\' in value:
        raise VerificationError('A focused test target must be a bounded repository path')
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or str(path) != value:
        raise VerificationError('A focused test target must stay inside the repository')
    root, suffix = ROOTS[profile]
    if path.suffix != suffix or not (path == PurePosixPath(root) or PurePosixPath(root) in path.parents):
        raise VerificationError('A focused test target is incompatible with the verification profile')
    if not (workspace / path).is_file():
        raise VerificationError('A focused test target does not exist')
    return str(path)


def focused_command(workspace: Path, profile: str, targets: object) -> list[str]:
    full_command(profile)
    if not isinstance(targets, list) or not 1 <= len(targets) <= 20:
        raise VerificationError('A code step needs one to twenty focused test targets')
    clean = [_target(workspace, profile, value) for value in targets]
    if len(set(clean)) != len(clean):
        raise VerificationError('Focused test targets must be unique')
    if profile == 'agentx-dispatcher-tests/v1':
        return ['python3', '-m', 'unittest', *clean]
    command = full_command(profile)
    return [*command, '--runTestsByPath', *clean]
