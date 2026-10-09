# Runtime maintenance lease for the launcher (#93). Sourced by ./agentx.
#
# Recreating Core or Benchmark can cut running work and leave a durable
# recovery quarantine on its host. Core owns the exclusion and the verdict
# (#47): it grants a maintenance lease only when the recreate cuts nothing,
# keeps new work out while the lease is held, and names what blocks it with
# the clean cancel route. The launcher takes the lease around the recreate and
# prints what Core returns.
#
# Only curl is required. Every call is bounded. The one retry is the drain
# wait (#253): when only background inference holds the runtime, the launcher
# asks it to pause and tries again for a bounded time.

RUNTIME_LEASE_REFUSAL=""
RUNTIME_LEASE_DRAIN_SECONDS="${AGENTX_RUNTIME_LEASE_DRAIN_SECONDS:-120}"
RUNTIME_LEASE_DRAIN_POLL_SECONDS="${AGENTX_RUNTIME_LEASE_DRAIN_POLL_SECONDS:-10}"
RUNTIME_LEASE_ID=""
RUNTIME_LEASE_GENERATION=""
RUNTIME_LEASE_CORE=""
RUNTIME_LEASE_HEARTBEAT_PID=""
RUNTIME_LEASE_TTL_MS="${AGENTX_RUNTIME_LEASE_TTL_MS:-900000}"
RUNTIME_LEASE_HEARTBEAT_SECONDS="${AGENTX_RUNTIME_LEASE_HEARTBEAT_SECONDS:-60}"

# What a recreate can cut. Recreating Core alone cuts Core inference but not
# a Benchmark profile, whose writer is in Benchmark: Core decides with its
# core-recreate lease. Benchmark and its runner own every workload writer, and
# conversations go Core -> Ollama, so a Benchmark-only recreate needs only
# Core's verdict that no workload runs. Recreating both, or every service when
# none is named, needs the global runtime-deploy lease.
# Prints all, core, benchmark, or nothing.
runtime_guard_scope() {
  local arg named=0 core=0 benchmark=0
  for arg in "$@"; do
    [[ "$arg" == -* ]] && continue
    named=1
    case "$arg" in
      core) core=1;;
      benchmark|benchmark-runner) benchmark=1;;
    esac
  done
  if [[ $named -eq 0 || ( $core -eq 1 && $benchmark -eq 1 ) ]]; then echo all
  elif [[ $core -eq 1 ]]; then echo core
  elif [[ $benchmark -eq 1 ]]; then echo benchmark; fi
}

# The Core maintenance scope for a guard scope.
runtime_lease_scope() {
  if [[ "$1" == "core" ]]; then echo core-recreate; else echo runtime-deploy; fi
}

# Prints the one-line summaries Core gives for each blocker of a JSON body.
runtime_print_blockers() {
  grep -oE '"summary":"[^"]*"' | sed -e 's/^"summary":"/  - /' -e 's/"$//' | head -n 20 >&2
}

runtime_guard_needed() {
  [[ -n "$(runtime_guard_scope "$@")" ]]
}

# runtime_deploy_blocked <core base url> <service>
# 0 when Core says recreating <service> would cut work; Core's blockers are
# printed. A Core without the verdict endpoint falls back to its workload list.
runtime_deploy_blocked() {
  RUNTIME_LEASE_CORE="$1"
  local verdict
  verdict="$(curl --silent --fail --max-time 10 "$RUNTIME_LEASE_CORE/api/nerve-center/runtime-coordination/deploy-blockers?service=$2" || true)"
  if [[ "$verdict" == *'"allowed":true'* ]]; then return 1; fi
  if [[ "$verdict" == *'"allowed":false'* ]]; then
    echo "Core reports work that recreating $2 would cut:" >&2
    printf '%s' "$verdict" | runtime_print_blockers
    return 0
  fi
  runtime_workloads_active "$1"
}

# 0 when Core lists at least one workload admission; the holders are printed.
runtime_workloads_active() {
  RUNTIME_LEASE_CORE="$1"
  local listing
  listing="$(curl --silent --max-time 10 "$RUNTIME_LEASE_CORE/api/nerve-center/runtime-coordination/active" || true)"
  printf '%s' "$listing" | grep -q '"workloadId"' || return 1
  echo "Benchmark work is active. Workloads reported by Core:" >&2
  printf '%s' "$listing" | grep -oE '"(workloadId|kind|state)":"[^"]*"|"hosts":\[[^]]*\]'     | sed 's/^/  /' | head -n 20 >&2
  return 0
}

runtime_lease_field() {
  # First string value of a JSON field; lease ids and generations are UUIDs.
  sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

runtime_lease_request() {
  local method="$1" path="$2" body="${3:-}"
  curl --silent --show-error --max-time 10 -X "$method" \
    -H 'Content-Type: application/json' -H 'X-AgentX-Caller: operator' \
    ${body:+--data "$body"} -w '\n%{http_code}' "$RUNTIME_LEASE_CORE$path"
}

# Names what holds the runtime: the blockers of Core's refusal, or else
# Core's own listing.
runtime_lease_describe_holders() {
  if [[ "$1" == *'"summary":"'* ]]; then
    echo "Core refused the runtime lease: this work would be cut:" >&2
    printf '%s' "$1" | runtime_print_blockers
    return 0
  fi
  local listing
  listing="$(curl --silent --max-time 10 "$RUNTIME_LEASE_CORE/api/nerve-center/runtime-coordination/active" || true)"
  echo "Core refused the runtime lease: work is active. Holders reported by Core:" >&2
  printf '%s' "$listing" | grep -oE '"(workloadId|kind|scope|state|host|model)":"[^"]*"|"hosts":\[[^]]*\]' \
    | sed 's/^/  /' | head -n 20 >&2
}

# runtime_lease_acquire <core base url> <scope>
# Returns 0 with a held lease, 10 when Core refuses (work is active), 11 when
# Core is unreachable (the caller decides whether to proceed without a lease).
runtime_lease_acquire() {
  local rc=0 waited=0
  runtime_lease_try "$1" "$2" || rc=$?
  if [[ $rc -eq 10 ]] && (( RUNTIME_LEASE_DRAIN_SECONDS > 0 )) && runtime_lease_drainable "$RUNTIME_LEASE_REFUSAL"; then
    echo "Only background inference holds the runtime: asking it to pause (up to ${RUNTIME_LEASE_DRAIN_SECONDS}s)." >&2
    runtime_lease_request POST /api/nerve-center/runtime-coordination/drain \
      "{\"scope\":\"$2\",\"ttlMs\":$(( (RUNTIME_LEASE_DRAIN_SECONDS + 30) * 1000 ))}" >/dev/null 2>&1 || true
    while (( waited < RUNTIME_LEASE_DRAIN_SECONDS )); do
      sleep "$RUNTIME_LEASE_DRAIN_POLL_SECONDS"
      waited=$(( waited + RUNTIME_LEASE_DRAIN_POLL_SECONDS ))
      rc=0
      runtime_lease_try "$1" "$2" || rc=$?
      [[ $rc -eq 10 ]] && runtime_lease_drainable "$RUNTIME_LEASE_REFUSAL" || break
    done
    runtime_lease_request DELETE /api/nerve-center/runtime-coordination/drain >/dev/null 2>&1 || true
  fi
  if [[ $rc -eq 10 ]]; then runtime_lease_describe_holders "$RUNTIME_LEASE_REFUSAL"; fi
  return $rc
}

# 0 when every blocker of a refusal is inference a short wait can outlast:
# resumable background work, which pauses on a drain request, and Core's own
# probes. Benchmark, interactive and maintenance holders keep refusing at once.
runtime_lease_drainable() {
  local kinds
  kinds="$(printf '%s' "$1" | grep -oE '"type":"[^"]*","kind":"[^"]*"' | sort -u)"
  [[ -n "$kinds" ]] || return 1
  ! printf '%s\n' "$kinds" | grep -qvE '^"type":"inference","kind":"(inference-automated|watchdog-probe)"$'
}

# One attempt: 0 held, 10 refused (the body is kept in RUNTIME_LEASE_REFUSAL), 11 unreachable.
runtime_lease_try() {
  RUNTIME_LEASE_CORE="$1"
  RUNTIME_LEASE_REFUSAL=""
  local scope="$2" response status body
  response="$(runtime_lease_request POST /api/nerve-center/maintenance-leases \
    "{\"requestId\":\"launcher-$(date +%s)-$$\",\"scope\":\"$scope\",\"ttlMs\":$RUNTIME_LEASE_TTL_MS}" 2>/dev/null)" || return 11
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [[ "$status" == "200" ]]; then
    RUNTIME_LEASE_ID="$(printf '%s' "$body" | runtime_lease_field leaseId)"
    RUNTIME_LEASE_GENERATION="$(printf '%s' "$body" | runtime_lease_field generation)"
    [[ -n "$RUNTIME_LEASE_ID" && -n "$RUNTIME_LEASE_GENERATION" ]] || return 11
    runtime_lease_start_heartbeat
    return 0
  fi
  if [[ "$status" == "409" ]]; then
    RUNTIME_LEASE_REFUSAL="$body"
    return 10
  fi
  return 11
}

runtime_lease_start_heartbeat() {
  (
    while sleep "$RUNTIME_LEASE_HEARTBEAT_SECONDS"; do
      # Core is briefly down while it is recreated; the TTL covers that gap.
      runtime_lease_request POST "/api/nerve-center/maintenance-leases/$RUNTIME_LEASE_ID/heartbeat" \
        "{\"generation\":\"$RUNTIME_LEASE_GENERATION\",\"ttlMs\":$RUNTIME_LEASE_TTL_MS}" >/dev/null 2>&1 || true
    done
  ) &
  RUNTIME_LEASE_HEARTBEAT_PID=$!
}

# Releases the held lease. Core may just have restarted, so the release is
# tried a few times; a lease that is never released expires into a quarantine
# that needs operator recovery, which the message says.
runtime_lease_release() {
  [[ -n "$RUNTIME_LEASE_ID" ]] || return 0
  if [[ -n "$RUNTIME_LEASE_HEARTBEAT_PID" ]]; then
    kill "$RUNTIME_LEASE_HEARTBEAT_PID" 2>/dev/null || true
    wait "$RUNTIME_LEASE_HEARTBEAT_PID" 2>/dev/null || true
    RUNTIME_LEASE_HEARTBEAT_PID=""
  fi
  local attempt response
  for attempt in 1 2 3 4 5; do
    response="$(runtime_lease_request DELETE "/api/nerve-center/maintenance-leases/$RUNTIME_LEASE_ID" \
      "{\"generation\":\"$RUNTIME_LEASE_GENERATION\"}" 2>/dev/null || true)"
    if [[ "${response##*$'\n'}" == "200" ]]; then
      RUNTIME_LEASE_ID=""
      return 0
    fi
    sleep 2
  done
  echo "The runtime maintenance lease $RUNTIME_LEASE_ID was not released. Release it before it expires:" >&2
  echo "  curl -X DELETE -H 'Content-Type: application/json' -H 'X-AgentX-Caller: operator' -d '{\"generation\":\"$RUNTIME_LEASE_GENERATION\"}' $RUNTIME_LEASE_CORE/api/nerve-center/maintenance-leases/$RUNTIME_LEASE_ID" >&2
  return 1
}
