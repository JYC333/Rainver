#!/usr/bin/env bash
# Opt-in real integration smoke for an isolated acceptance space. The caller
# creates the dedicated records in the UI, then supplies their opaque IDs here.

set -euo pipefail

required_commands=(curl jq)
for command_name in "${required_commands[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 2
  }
done

required_variables=(
  ACCEPTANCE_AUTH_TOKEN
  ACCEPTANCE_SPACE_ID
  ACCEPTANCE_MANAGED_RUN_ID
  ACCEPTANCE_SOURCE_CHANNEL_ID
  ACCEPTANCE_SOURCE_RULE_ID
  ACCEPTANCE_OPENCODE_RUN_ID
  ACCEPTANCE_VALIDATION_FAILURE_RUN_ID
  ACCEPTANCE_CANCELLATION_RUN_ID
  ACCEPTANCE_FALLBACK_RUN_ID
)
for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Missing $variable_name. See .agent/architecture/PRODUCT_ACCEPTANCE.md." >&2
    exit 2
  fi
done

API_BASE="${ACCEPTANCE_API_BASE:-http://localhost:3000/api/v1}"
POLL_SECONDS="${ACCEPTANCE_POLL_SECONDS:-2}"
POLL_LIMIT="${ACCEPTANCE_POLL_LIMIT:-90}"

api() {
  local method="$1"
  local path="$2"
  curl --fail --silent --show-error \
    --request "$method" \
    --header "Authorization: Bearer $ACCEPTANCE_AUTH_TOKEN" \
    --header "X-Rainver-Space-Id: $ACCEPTANCE_SPACE_ID" \
    --header "Content-Type: application/json" \
    "$API_BASE$path"
}

wait_for_terminal() {
  local run_id="$1"
  local attempt status
  for ((attempt = 1; attempt <= POLL_LIMIT; attempt += 1)); do
    status="$(api GET "/runs/$run_id" | jq -r '.status')"
    case "$status" in
      succeeded|failed|cancelled|degraded|orphaned|waiting_for_review)
        printf '%s\n' "$status"
        return 0
        ;;
    esac
    sleep "$POLL_SECONDS"
  done
  echo "Run did not reach a terminal/review state: $run_id" >&2
  return 1
}

execute_and_expect() {
  local run_id="$1"
  local expected="$2"
  api POST "/runs/$run_id/execute" >/dev/null
  local status
  status="$(wait_for_terminal "$run_id")"
  if [[ ! "$status" =~ $expected ]]; then
    echo "Unexpected Run status for $run_id: $status (expected $expected)" >&2
    return 1
  fi
}

wait_for_active() {
  local run_id="$1"
  local attempt status
  for ((attempt = 1; attempt <= POLL_LIMIT; attempt += 1)); do
    status="$(api GET "/runs/$run_id" | jq -r '.status')"
    case "$status" in
      running|cancelling)
        return 0
        ;;
      succeeded|failed|cancelled|degraded|orphaned|waiting_for_review)
        echo "Run became terminal/reviewable before cancellation: $run_id ($status)" >&2
        return 1
        ;;
    esac
    sleep "$POLL_SECONDS"
  done
  echo "Run did not become active before cancellation: $run_id" >&2
  return 1
}

echo "==> Real Managed API model call"
execute_and_expect "$ACCEPTANCE_MANAGED_RUN_ID" '^succeeded$'
api GET "/runs/$ACCEPTANCE_MANAGED_RUN_ID/io" | jq -e '.input != null and .output != null' >/dev/null

echo "==> Real Source acquisition and post-processing"
api POST "/sources/channels/$ACCEPTANCE_SOURCE_CHANNEL_ID/scan" >/dev/null
api POST "/sources/channels/$ACCEPTANCE_SOURCE_CHANNEL_ID/post-processing/rules/$ACCEPTANCE_SOURCE_RULE_ID/run" >/dev/null

echo "==> Real OpenCode file/tool Run"
execute_and_expect "$ACCEPTANCE_OPENCODE_RUN_ID" '^(succeeded|waiting_for_review)$'
api GET "/runs/$ACCEPTANCE_OPENCODE_RUN_ID/io" | jq -e '.events != null' >/dev/null

if [[ -n "${ACCEPTANCE_VENDOR_CLI_RUN_ID:-}" ]]; then
  echo "==> Optional configured Codex/Claude Run"
  execute_and_expect "$ACCEPTANCE_VENDOR_CLI_RUN_ID" '^(succeeded|waiting_for_review)$'
fi

echo "==> Structured-output validation failure"
execute_and_expect "$ACCEPTANCE_VALIDATION_FAILURE_RUN_ID" '^(failed|degraded)$'
api GET "/runs/$ACCEPTANCE_VALIDATION_FAILURE_RUN_ID/verifications" \
  | jq -e 'any(.[]; .status == "failed")' >/dev/null

echo "==> Cancellation"
api POST "/runs/$ACCEPTANCE_CANCELLATION_RUN_ID/execute" >/dev/null &
cancellation_execute_pid=$!
if ! wait_for_active "$ACCEPTANCE_CANCELLATION_RUN_ID"; then
  wait "$cancellation_execute_pid" || true
  exit 1
fi
api PATCH "/runs/$ACCEPTANCE_CANCELLATION_RUN_ID/stop" >/dev/null
if [[ "$(wait_for_terminal "$ACCEPTANCE_CANCELLATION_RUN_ID")" != "cancelled" ]]; then
  wait "$cancellation_execute_pid" || true
  echo "Cancellation Run did not finish as cancelled." >&2
  exit 1
fi
wait "$cancellation_execute_pid"

echo "==> Transient failure and fallback evidence"
execute_and_expect "$ACCEPTANCE_FALLBACK_RUN_ID" '^(succeeded|degraded|waiting_for_review)$'
api GET "/runs/$ACCEPTANCE_FALLBACK_RUN_ID/attempts" \
  | jq -e '(.attempts | length) > 1 or (.supervisor_decisions | length) > 0' >/dev/null
api GET "/runs/$ACCEPTANCE_FALLBACK_RUN_ID/route-decision" | jq -e 'type == "object"' >/dev/null

echo "Real integration smoke passed. Inspect the listed Runs in Operations before deleting the dedicated test data."
