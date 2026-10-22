"""Build the coding worker's Bubblewrap command without owning a harness."""
from pathlib import Path


def build(workspace: Path, home: Path, command: list[str], *, network: bool, timeout_seconds: int,
          node_root: Path, coding_root: Path, request_pattern,
          read_only=False, report_request_id='', prompt_file=None, prompt_target='',
          environment=None, extra_binds=None) -> list[str]:
    if report_request_id and (not read_only or not request_pattern.fullmatch(report_request_id)):
        raise ValueError('A private working directory requires its read-only source and exact request UUID')
    directory = f'/home/agent/deliverables/{report_request_id}' if report_request_id else '/workspace'
    return [
        'timeout', '-k', '30', str(timeout_seconds),
        'bwrap', '--unshare-all', *(['--share-net'] if network else []),
        '--die-with-parent', '--new-session', '--clearenv',
        '--setenv', 'HOME', '/home/agent', '--setenv', 'USER', 'agent',
        '--setenv', 'PATH', '/opt/node/bin:/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
        '--setenv', 'DSH_HOME', '/home/agent/.dsh', '--setenv', 'DSH_PERMISSION_MODE', 'workspace-write',
        '--setenv', 'DSH_TELEMETRY_MODE', 'DISABLED', '--setenv', 'AGENTX_CORE_API_KEY', 'local-no-auth',
        *(arg for name, value in (environment or {}).items() for arg in ('--setenv', name, value)),
        '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
        '--symlink', 'usr/bin', '/bin', '--dir', '/etc',
        *(arg for name in ('hosts', 'resolv.conf', 'nsswitch.conf', 'ssl', 'passwd', 'group')
          for arg in ('--ro-bind', f'/etc/{name}', f'/etc/{name}')),
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home',
        *(['--ro-bind', str(prompt_file), prompt_target] if prompt_file is not None else []),
        '--bind', str(home), '/home/agent', '--ro-bind', str(node_root), '/opt/node',
        '--ro-bind', str(coding_root), '/opt/coding',
        *(arg for source, target in (extra_binds or []) for arg in ('--ro-bind', source, target)),
        '--ro-bind', str(coding_root.parent.parent / 'shared/testing/prepareMongo.js'), '/opt/prepareMongo.js',
        '--ro-bind' if read_only else '--bind', str(workspace), '/workspace',
        '--ro-bind', str(workspace / '.git'), '/workspace/.git', '--chdir', directory, *command,
    ]
