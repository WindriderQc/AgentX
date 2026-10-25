# Runtime topology actuator

A small privileged program on a GPU host that applies the runtime units of one
declared topology mode (#360, phase 3). Core never gets a shell on the host: it
reaches the actuator through an SSH key whose `authorized_keys` entry forces
this program, and the program accepts four commands only.

| Command | Effect |
|---|---|
| `status [--request-id ID]` | Read-only. Which declared units run, the mode they form (`observedMode`: a mode, `mixed` or `none`), the last confirmed mode, a pending activation, the safety timer, memory per GPU from `nvidia-smi`, compute processes, and the active mode's endpoints (`/api/version`). With `--request-id`, also the stored receipts of that request. |
| `activate <mode> --request-id ID` | Arms the safety timer, stops every unit of the other modes, waits until the mode's GPUs are free, starts the mode's units and waits until each endpoint answers `/api/version`. Never runs two modes at once. |
| `confirm --request-id ID` | Core has verified the new mode. Cancels the safety timer and makes the mode the one that starts at boot (enables its units, disables the others). |
| `rollback --request-id ID [--reason R]` | Back to the last confirmed mode, with the same stop, wait and start sequence. |

Mode names come from the configuration file. Request ids match
`[A-Za-z0-9][A-Za-z0-9._:-]{0,119}`; reasons are lowercase words with `_`.
Anything else is refused with exit code 2, and the refused text is never
echoed back.

## Safety

- **Safety timer.** `activate` arms a transient systemd timer
  (`systemd-run --on-active`) before it stops anything. If no `confirm` comes
  within `safetyTimeoutSec` (default 20 min), the timer runs `rollback` for that
  activation only. A timer left from an activation that was already confirmed or
  rolled back does nothing.
- **Failure inside `activate`.** The actuator restores the previous mode at once
  (`restored: true`) and cancels the timer. If even the restore fails, the timer
  stays armed and tries again at its deadline.
- **Reboot or crash.** Unit enablement changes only on `confirm`, so a host that
  reboots during a switch starts in the last confirmed mode. Transient timers do
  not survive a reboot; `status` then reports the pending activation with
  `safetyTimer.state: "lost"`, and Core calls `rollback`.
- **Lost connection.** The SSH entry ignores `SIGHUP` and `SIGPIPE`, so a dropped
  connection does not stop a switch half-way. Every receipt is persisted before
  it is printed. Read it back with `status --request-id ID`; never start a second
  activation while the first one's outcome is unknown.
- **Idempotency.** Repeating `activate`, `confirm` or `rollback` with the same
  request id returns the stored receipt (`replay: true`) without acting again.
  An `activate` whose process died before finishing returns
  `outcome: "interrupted"` (exit 3) instead of running again.
- **One command at a time.** Mutating commands take a file lock in the state
  directory; a second command waits up to `lockTimeoutSec`, then is refused
  (`actuator_busy`, exit 4). `status` never waits.

## Receipt

Every call prints one JSON object, `schema: "agentx.runtime-topology-actuation/v1"`:

- `command`, `requestId`, `group`, `host`, `startedAt`, `finishedAt`;
- `outcome`: `observed`, `activated`, `already_active`, `confirmed`,
  `rolled_back`, `noop`, `failed`, `refused` or `interrupted`, with `reason`
  when it is not a success;
- `modeBefore`, `modeAfter`, `confirmedModeBefore`, `confirmedModeAfter`,
  `targetMode`;
- `unitsStopped`, `unitsStarted`; on a failed activation, `restore` with its own
  units and timings, and `restored`;
- `gpusBefore`, `gpusReleased`, `gpus`: index, UUID, used and total MiB;
- `endpoints`: URL, ready, Ollama version;
- `timings`: `stopMs`, `gpuReleaseMs`, `startMs`, `readyMs`, `totalMs`;
- `safetyTimer`: unit, `armed`, `disarmed`, `none` or `lost`, and deadline;
- `enablement` on `confirm`, and `warnings` when a non-blocking step failed.

Exit codes: 0 success, 1 failed, 2 usage or configuration, 3 unknown
(interrupted activation, unreadable state), 4 refused (busy, pending, wrong id,
target not running).

## Configuration

`/etc/agentx/topology-actuator.json`, owned by root and kept by the instance,
not in this repository. See `topology-actuator.example.json`.

- `group`: the topology group id Core declares in `AGENTX_RUNTIME_TOPOLOGY_JSON`.
- `defaultMode`: the mode assumed confirmed before the first switch, when the
  running units do not form exactly one mode.
- `modes.<id>.units`: the systemd units of that mode; a unit belongs to one mode.
  Units of the host that are not listed (a CPU Ollama, for example) are never
  touched.
- `modes.<id>.endpoints`: local URLs whose `/api/version` must answer.
- `modes.<id>.gpus`: `nvidia-smi` indexes that must be free (at most
  `gpuFreeMiB` used each) before the mode starts. Another program holding one of
  them makes the switch fail with `gpu_not_released` and restore.
- `limits`: `unitTimeoutSec`, `gpuReleaseTimeoutSec`, `gpuFreeMiB`,
  `readyTimeoutSec`, `safetyTimeoutSec` (300 to 7200), `lockTimeoutSec`,
  `pollIntervalSec`.
- `stateDir` (default `/var/lib/agentx-topology-actuator`): `state.json`, the
  lock and the last 200 receipts.

The actuator itself holds no host name, port or model. The mode units are
ordinary systemd services written by the instance.

## Installation (operator)

1. Copy `agentx_topology_actuator.py` to `/usr/local/sbin/agentx-topology-actuator`
   (root, mode 0755) and `ssh-entry.sh` to
   `/usr/local/lib/agentx-topology-actuator/ssh-entry.sh` (root, 0755).
2. Write `/etc/agentx/topology-actuator.json` (root, 0644) and install the mode
   units. Check with `sudo agentx-topology-actuator status`.
3. Create a system account without a password, for example `agentx-topology`,
   and install `sudoers.example` as `/etc/sudoers.d/agentx-topology-actuator`
   after `visudo -cf`.
4. Generate a dedicated key on the Core side and authorize it for that account
   only:

   ```text
   restrict,from="<core host address>",command="/usr/local/lib/agentx-topology-actuator/ssh-entry.sh" ssh-ed25519 AAAA… agentx-topology-actuator
   ```

   `restrict` disables the pty, forwarding and agent; `command=` replaces
   whatever the client sends; `from=` limits the source address.
5. From the Core host, with that key: `ssh -i <key> agentx-topology@<gpu host> status`
   returns the status receipt; `ssh … bash` returns a refusal.

## Tests

`python3 -m unittest discover -s integrations/topology-actuator -p 'test_*.py'`
runs the actuator against a fake systemd, a fake `nvidia-smi` and a simulated
clock. They do not prove the real units, the timer on a real systemd or the
sudo and SSH entry; qualify those on the host after installation.
