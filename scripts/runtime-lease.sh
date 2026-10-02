# Runtime maintenance lease for the launcher (#93). Sourced by ./agentx.
#
# Recreating Core or Benchmark while a Benchmark workload runs cuts its
# heartbeat and leaves a durable recovery quarantine that blocks the host for
# the admission's lifetime. Core already owns the exclusion: a maintenance
# lease is refused while any workload or inference is active and keeps new
# ones out while held. The launcher takes it around the recreate.
#
# Only curl is required. Every call is bounded; nothing retries in a loop.

RUNTIME_LEASE_ID=""
RUNTIME_LEASE_GENERATION=""
RUNTIME_LEASE_CORE=""
RUNTIME_LEASE_HEARTBEAT_PID=""
RUNTIME_LEASE_TTL_MS="${AGENTX_RUNTIME_LEASE_TTL_MS:-900000}"
RUNTIME_LEASE_HEARTBEAT_SECONDS="${AGENTX_RUNTIME_LEASE_HEARTBEAT_SECONDS:-60}"

# What a recreate can cut. Core carries every inference, so recreating it
# (or every service, when none is named) needs the global lease. Benchmark and
# its runner only carry Benchmark workloads: conversations go Core -> Ollama
# and are untouched, so those need only "no Benchmark workload is active".
# Prints core, benchmark, or nothing.
runtime_guard_scope() {
  local arg named=0 benchmark=0
  for arg in "$@"; do
    [[ "$arg" == -* ]] && continue
    named=1
    case "$arg" in
      core) echo core; return 0;;
      benchmark|benchmark-runner) benchmark=1;;
    esac
  done
  if [[ $named -eq 0 ]]; then echo core; elif [[ $benchmark -eq 1 ]]; then echo benchmark; fi
}

runtime_guard_needed() {
  [[ -n "$(runtime_guard_scope "$@")" ]]
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

# Names what holds the runtime, from Core's own listing.
runtime_lease_describe_holders() {
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
  RUNTIME_LEASE_CORE="$1"
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
    runtime_lease_describe_holders
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
