#!/usr/bin/env node
// Stands in for the Codex CLI during `island_runner.py start --netcheck`.
// Clawblox runs the agent binary with Node inside its sandbox, so this probe
// is JavaScript. It checks what the agent can and cannot reach, writes
// netcheck.txt in the workspace, then idles until the run stops it. No
// inference. Targets come from the runner configuration (NETCHECK_* below).
const { spawnSync } = require("child_process");

// Clawblox first asks `codex app-server` for hook trust; decline at once.
if (process.argv[2] === "app-server") process.exit(1);

const script = String.raw`
out="$PWD/netcheck.txt"
code() { curl -s -o /dev/null -m 6 -w '%{http_code}' "$@" 2>/dev/null || true; }
check() {
  local verdict=FAIL
  [[ "$3" == $2 ]] && verdict=PASS
  printf '%-44s expected=%-6s got=%-6s %s\n' "$1" "$2" "$3" "$verdict" >>"$out"
}
: >"$out"
echo "netcheck $(date -Iseconds)  WORLD_BASE_URL=$WORLD_BASE_URL" >>"$out"
check "world observe with session (allowed)" 200 "$(code -H "X-Session: $WORLD_SESSION_ID" "$WORLD_BASE_URL/observe")"
check "core gateway without token (reachable)" 401 "$(code "$NETCHECK_GATEWAY")"
check "core gateway direct (blocked)" 000 "$(code "$NETCHECK_GATEWAY_DIRECT")"
for url in $NETCHECK_BLOCKED; do check "$url (blocked)" 000 "$(code "$url")"; done
check "internet example.com (blocked)" 000 "$(code https://example.com/)"
check "docker socket hidden" absent "$([[ -e /run/docker.sock ]] && echo present || echo absent)"
check "runner account home hidden" absent "$([[ -n "$NETCHECK_HOST_HOME" && -e "$NETCHECK_HOST_HOME" ]] && echo present || echo absent)"
check "host processes hidden" absent "$(ps -eo comm= | grep -q -x -E 'sshd|tmux: server|systemd|clawblox' && echo present || echo absent)"
check "world operator token removed" absent "$([[ -n "$WORLD_OPERATOR_TOKEN" ]] && echo present || echo absent)"
check "world loopback URL removed" absent "$([[ -n "$WORLD_INTERNAL_BASE_URL" ]] && echo present || echo absent)"
check "openai login not copied" absent "$([[ -e $HOME/.codex/auth.json ]] && echo present || echo absent)"
echo "failures: $(grep -c FAIL "$out")" >>"$out"
`;

// Imitate the Codex files Clawblox and the runner read, so the stall
// watchdog and the stop-then-resume path can be tested without a model.
const fs = require("fs");
const path = require("path");
const codexHome = path.join(process.env.HOME, ".codex");
const sessionId = "00000000-0000-4000-8000-00000000c0de";
const rollout = path.join(codexHome, "sessions", "2026", "10", "27", `rollout-probe-${sessionId}.jsonl`);
const calls = path.join(process.cwd(), "probe-calls.log");
const resuming = process.argv.includes("resume");
fs.appendFileSync(calls, `${new Date().toISOString()} ${resuming ? "resume" : "start"} ${JSON.stringify(process.argv.slice(2).slice(-2))}\n`);
fs.mkdirSync(path.dirname(rollout), { recursive: true });
if (!resuming) {
  spawnSync("bash", ["-c", script], { stdio: "inherit" });
  fs.appendFileSync(path.join(codexHome, "history.jsonl"), JSON.stringify({ session_id: sessionId, ts: Date.now(), text: "Begin." }) + "\n");
  // A turn that ended in error, as an output-token cutoff does.
  fs.appendFileSync(rollout, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", error: { message: "Incomplete response returned, reason: max_output_tokens" } } }) + "\n");
} else {
  fs.appendFileSync(rollout, JSON.stringify({ type: "event_msg", payload: { type: "user_message" } }) + "\n");
}
setInterval(() => {}, 1 << 30);
