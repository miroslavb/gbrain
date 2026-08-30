#!/usr/bin/env bash
# Source-scoped, restart-safe driver for bounded extract_atoms cycles.
#
# One process owns one source. gbrain's source-scoped cycle lock remains the
# correctness boundary; this wrapper adds durable progress/error receipts and
# prevents two local wrappers from churning on the same source lock.

set -u

usage() {
  cat <<'EOF'
Usage: atom-mine-source-worker.sh <source-id>

Environment:
  ATOM_MINE_REPO_DIR          gbrain checkout (default: /root/gbrain)
  ATOM_MINE_STATE_DIR         private logs/state (default: /root/.gbrain/atom-mining)
  ATOM_MINE_GBRAIN_BIN        CLI path (default: gbrain)
  ATOM_MINE_TIMEOUT_SECONDS   per-cycle timeout (default: 1800)
  ATOM_MINE_SLEEP_SECONDS     pause between cycles (default: 20)
  ATOM_MINE_MAX_BATCHES       stop after N cycles; 0 means unlimited (default: 0)
  ATOM_MINE_MAX_ERROR_STREAK  fail closed after N bad cycles (default: 3)
  ATOM_MINE_FALLBACK_CHAIN    chat fallback after GLM (default: openai:gpt-5.6-terra)

To request a clean stop, create <state-dir>/<source-id>.STOP.
EOF
}

if [[ ${1:-} == "--help" || ${1:-} == "-h" ]]; then
  usage
  exit 0
fi
if [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

source_id=$1
if [[ ! $source_id =~ ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$ ]]; then
  echo "invalid source id: $source_id" >&2
  exit 2
fi

repo_dir=${ATOM_MINE_REPO_DIR:-/root/gbrain}
state_dir=${ATOM_MINE_STATE_DIR:-/root/.gbrain/atom-mining}
gbrain_bin=${ATOM_MINE_GBRAIN_BIN:-gbrain}
timeout_seconds=${ATOM_MINE_TIMEOUT_SECONDS:-1800}
sleep_seconds=${ATOM_MINE_SLEEP_SECONDS:-20}
max_batches=${ATOM_MINE_MAX_BATCHES:-0}
max_error_streak=${ATOM_MINE_MAX_ERROR_STREAK:-3}
fallback_chain=${ATOM_MINE_FALLBACK_CHAIN:-openai:gpt-5.6-terra}

for numeric_name in timeout_seconds sleep_seconds max_batches max_error_streak; do
  numeric_value=${!numeric_name}
  if [[ ! $numeric_value =~ ^[0-9]+$ ]]; then
    echo "$numeric_name must be a non-negative integer" >&2
    exit 2
  fi
done
if (( timeout_seconds == 0 || max_error_streak == 0 )); then
  echo "timeout_seconds and max_error_streak must be positive" >&2
  exit 2
fi
if [[ ! -d $repo_dir ]]; then
  echo "repo directory does not exist: $repo_dir" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 2
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required" >&2
  exit 2
fi

mkdir -p "$state_dir"
summary_log="$state_dir/$source_id.batches.jsonl"
report_log="$state_dir/$source_id.reports.jsonl"
error_log="$state_dir/$source_id.stderr.log"
heartbeat="$state_dir/$source_id.heartbeat.json"
pid_file="$state_dir/$source_id.pid"
stop_file="$state_dir/$source_id.STOP"
worker_lock="$state_dir/$source_id.worker.lock"

exec 9>"$worker_lock"
if ! flock -n 9; then
  echo "worker already active for source: $source_id" >&2
  exit 75
fi

printf '%s\n' "$$" >"$pid_file"
cleanup() {
  rm -f "$pid_file"
}
on_signal() {
  exit 143
}
trap cleanup EXIT
trap on_signal INT TERM

write_state() {
  local state=$1
  local batch=$2
  local error_streak=$3
  local message=${4:-}
  local tmp="$heartbeat.tmp.$$"
  jq -cn \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg source_id "$source_id" \
    --arg state "$state" \
    --arg message "$message" \
    --argjson pid "$$" \
    --argjson batch "$batch" \
    --argjson error_streak "$error_streak" \
    '{timestamp:$timestamp,source_id:$source_id,state:$state,pid:$pid,batch:$batch,error_streak:$error_streak,message:$message}' \
    >"$tmp"
  mv "$tmp" "$heartbeat"
}

batch=0
idle_streak=0
error_streak=0
write_state starting "$batch" "$error_streak"

while :; do
  if [[ -f $stop_file ]]; then
    write_state stopped "$batch" "$error_streak" stop_file
    exit 0
  fi
  if (( max_batches > 0 && batch >= max_batches )); then
    write_state completed "$batch" "$error_streak" max_batches
    exit 0
  fi

  batch=$((batch + 1))
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  started_epoch_ms=$(date -u +%s%3N)
  stdout_file=$(mktemp "$state_dir/$source_id.stdout.XXXXXX")
  stderr_file=$(mktemp "$state_dir/$source_id.stderr.XXXXXX")
  write_state running "$batch" "$error_streak"

  (
    cd "$repo_dir" || exit 2
    GBRAIN_CHAT_FALLBACK_CHAIN="$fallback_chain" timeout "$timeout_seconds" "$gbrain_bin" dream \
      --source "$source_id" --phase extract_atoms --once --json
  ) >"$stdout_file" 2>"$stderr_file"
  command_rc=$?

  finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  finished_epoch_ms=$(date -u +%s%3N)
  elapsed_ms=$((finished_epoch_ms - started_epoch_ms))

  if [[ -s $stderr_file ]]; then
    {
      printf '[%s source=%s batch=%s rc=%s]\n' "$finished_at" "$source_id" "$batch" "$command_rc"
      sed -E '/UPGRADE_AVAILABLE|self-upgrade/d' "$stderr_file"
    } >>"$error_log"
  fi

  valid_report=false
  if jq -e '.schema_version == "1" and (.phases | type == "array")' "$stdout_file" >/dev/null 2>&1; then
    valid_report=true
    jq -c --arg worker_source "$source_id" --arg worker_finished_at "$finished_at" \
      '. + {worker_source:$worker_source,worker_finished_at:$worker_finished_at}' \
      "$stdout_file" >>"$report_log"
  fi

  if [[ $valid_report == true ]]; then
    phase=$(jq -c '[.phases[] | select(.phase == "extract_atoms")][0] // {}' "$stdout_file")
    report_status=$(jq -r '.status // "missing"' "$stdout_file")
    report_reason=$(jq -r '.reason // ""' "$stdout_file")
    phase_status=$(jq -r '.status // "missing"' <<<"$phase")
    pages_processed=$(jq -r '.details.pages_processed // 0' <<<"$phase")
    pages_total=$(jq -r '.details.pages_total // 0' <<<"$phase")
    atoms_extracted=$(jq -r '.details.atoms_extracted // 0' <<<"$phase")
    candidates=$(jq -r '.details.candidates // 0' <<<"$phase")
    accepted=$(jq -r '.details.accepted // 0' <<<"$phase")
    rejected=$(jq -r '.details.rejected // 0' <<<"$phase")
    failures=$(jq -r '(.details.failures // []) | length' <<<"$phase")
    pages_skipped_budget=$(jq -r '.details.pages_skipped_budget // 0' <<<"$phase")
    duplicates_skipped=$(jq -r '.details.duplicates_skipped // 0' <<<"$phase")
    malformed_outputs=$(jq -r '.details.malformed_outputs // 0' <<<"$phase")
    validator_errors=$(jq -r '[.details.failures[]? | select((.error // "") | startswith("semantic_validator_"))] | length' <<<"$phase")
    validator_timeouts=$(jq -r '[.details.failures[]? | select((.error // "") == "semantic_validator_timeout")] | length' <<<"$phase")
    provider_errors=$(jq -r '[.details.failures[]? | select((.error // "") | test("rate.?limit|429|billing|auth|provider|ollama"; "i"))] | length' <<<"$phase")
    aborted_global_error=$(jq -r '.details.aborted_global_error // ""' <<<"$phase")
    estimated_spend_usd=$(jq -r '.details.estimated_spend_usd // 0' <<<"$phase")
    budget_usd=$(jq -r '.details.budget_usd // 0' <<<"$phase")
  else
    report_status=invalid_json
    report_reason=invalid_json
    phase_status=missing
    pages_processed=0
    pages_total=0
    atoms_extracted=0
    candidates=0
    accepted=0
    rejected=0
    failures=0
    pages_skipped_budget=0
    duplicates_skipped=0
    malformed_outputs=0
    validator_errors=0
    validator_timeouts=0
    provider_errors=0
    aborted_global_error=""
    estimated_spend_usd=0
    budget_usd=0
  fi

  good_cycle=true
  if (( command_rc != 0 )) || [[ $valid_report != true ]] || [[ $report_status == failed ]] || \
     [[ $report_status == skipped && $report_reason == cycle_already_running ]] || \
     [[ -n $aborted_global_error ]] || (( validator_errors > 0 || provider_errors > 0 )); then
    good_cycle=false
  fi

  if [[ $good_cycle == true ]]; then
    error_streak=0
  else
    error_streak=$((error_streak + 1))
  fi

  jq -cn \
    --arg started_at "$started_at" \
    --arg finished_at "$finished_at" \
    --arg source_id "$source_id" \
    --arg report_status "$report_status" \
    --arg report_reason "$report_reason" \
    --arg phase_status "$phase_status" \
    --arg aborted_global_error "$aborted_global_error" \
    --argjson batch "$batch" \
    --argjson elapsed_ms "$elapsed_ms" \
    --argjson command_rc "$command_rc" \
    --argjson pages_processed "$pages_processed" \
    --argjson pages_total "$pages_total" \
    --argjson atoms_extracted "$atoms_extracted" \
    --argjson candidates "$candidates" \
    --argjson accepted "$accepted" \
    --argjson rejected "$rejected" \
    --argjson failures "$failures" \
    --argjson pages_skipped_budget "$pages_skipped_budget" \
    --argjson duplicates_skipped "$duplicates_skipped" \
    --argjson malformed_outputs "$malformed_outputs" \
    --argjson validator_errors "$validator_errors" \
    --argjson validator_timeouts "$validator_timeouts" \
    --argjson provider_errors "$provider_errors" \
    --argjson estimated_spend_usd "$estimated_spend_usd" \
    --argjson budget_usd "$budget_usd" \
    --argjson error_streak "$error_streak" \
    '{started_at:$started_at,finished_at:$finished_at,source_id:$source_id,batch:$batch,elapsed_ms:$elapsed_ms,command_rc:$command_rc,report_status:$report_status,report_reason:$report_reason,phase_status:$phase_status,pages_processed:$pages_processed,pages_total:$pages_total,pages_skipped_budget:$pages_skipped_budget,atoms_extracted:$atoms_extracted,candidates:$candidates,accepted:$accepted,rejected:$rejected,failures:$failures,duplicates_skipped:$duplicates_skipped,malformed_outputs:$malformed_outputs,validator_errors:$validator_errors,validator_timeouts:$validator_timeouts,provider_errors:$provider_errors,aborted_global_error:$aborted_global_error,estimated_spend_usd:$estimated_spend_usd,budget_usd:$budget_usd,error_streak:$error_streak}' \
    >>"$summary_log"

  rm -f "$stdout_file" "$stderr_file"

  if [[ $report_reason == no_work ]] || (( pages_total == 0 && command_rc == 0 )); then
    idle_streak=$((idle_streak + 1))
  else
    idle_streak=0
  fi
  if (( idle_streak >= 2 )); then
    write_state drained "$batch" "$error_streak" no_work
    exit 0
  fi
  if (( error_streak >= max_error_streak )); then
    write_state failed "$batch" "$error_streak" error_streak
    exit 1
  fi

  write_state sleeping "$batch" "$error_streak"
  sleep "$sleep_seconds"
done
