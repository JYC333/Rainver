#!/usr/bin/env bash
# PostToolUse hook — remind agents to update .agent/ docs when structural files change.
#
# Claude Code passes tool input as JSON on stdin:
#   {"tool_name": "Edit", "tool_input": {"file_path": "...", ...}, "tool_response": {...}}
#
# Exit 0 = feedback only (no block). Exit 2 = block the tool call (PreToolUse only).

set -euo pipefail

input=$(cat)

# Extract file_path from tool_input.
file_path=$(printf '%s' "$input" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('file_path', ''))
except Exception:
    print('')
" 2>/dev/null)

[[ -z "$file_path" ]] && exit 0

basename_file=$(basename "$file_path")
relevant_docs=""

# Path-aware map from current TypeScript repo structure to the .agent docs that
# should be reviewed after edits. Keep this list current with the source-of-truth
# hierarchy in .agent/INDEX.md and the server route registry.
case "$file_path" in
    *server/src/gateway/routeRegistry.ts)
        relevant_docs="architecture/MODULES.md, architecture/SERVER_OWNERSHIP.md, architecture/SERVER_MODULE_CONVENTION.md, architecture/CURRENT_REPO_SUMMARY.md"
        ;;
    *server/src/server.ts|*server/src/index.ts)
        relevant_docs="architecture/SERVER_FOUNDATION.md, architecture/SERVER_MODULE_CONVENTION.md, architecture/CURRENT_REPO_SUMMARY.md"
        ;;
    *server/src/config.ts|*ops/env/.env*.example|*ops/compose/docker-compose.*.yml|*ops/scripts/lib/local-compose.sh)
        relevant_docs="architecture/SERVER_FOUNDATION.md, architecture/OPERATIONS_AND_SAFETY.md, COMMANDS.md, architecture/CURRENT_REPO_SUMMARY.md"
        ;;
    *server/src/db/*|*server/migrations/*)
        relevant_docs="architecture/DATABASE_AND_TRANSACTIONS.md, architecture/SERVER_FOUNDATION.md, architecture/CURRENT_REPO_SUMMARY.md"
        ;;
    *server/src/modules/runs/*|*server/src/modules/runtimeHost/*|*server/src/modules/runtimeAdapters/*|*server/src/modules/runtimeTools/*|*server/src/modules/runtimeToolBindings/*|*server/src/modules/executionPlanes/*)
        relevant_docs="architecture/EXECUTION_MODEL.md, architecture/RUNS_AND_OUTPUTS.md, modules/runtime-adapters.md, modules/agents.md, architecture/MODULES.md"
        ;;
    *server/src/modules/memory/*|*server/src/modules/context/*|*server/src/modules/activity/*|*server/src/modules/proposals/*)
        relevant_docs="architecture/MEMORY_ACTIVITY_PROVENANCE.md, architecture/MEMORY_MODEL.md, architecture/PROPOSALS.md, architecture/POLICY_ENFORCEMENT_INVENTORY.md, architecture/MODULES.md"
        ;;
    *server/src/modules/policy/*|*server/src/modules/personalMemoryGrants/*)
        relevant_docs="architecture/SECURITY_AND_ACCESS_BOUNDARIES.md, architecture/POLICY_ENFORCEMENT_INVENTORY.md, architecture/MEMORY_MODEL.md, BOUNDARIES.md"
        ;;
    *server/src/modules/workspaces/*|*server/src/modules/workspaceProfiles/*|*server/src/modules/artifacts/*)
        relevant_docs="architecture/ARTIFACTS.md, architecture/EXECUTION_MODEL.md, modules/workspace-console.md, modules/sandbox.md, architecture/MODULES.md"
        ;;
    *server/src/modules/knowledge/*|*server/src/modules/intake/*|*server/src/modules/sourcePointers/*)
        relevant_docs="modules/knowledge-base.md, architecture/MEMORY_ACTIVITY_PROVENANCE.md, architecture/MODULES.md"
        ;;
    *server/src/modules/tasks/*|*server/src/modules/automations/*|*server/src/modules/dailyReports/*|*server/src/modules/jobs/*|*server/src/modules/backups/*|*server/src/modules/deployment/*)
        relevant_docs="architecture/TASK_BOARD_MODEL.md, architecture/OPERATIONS_AND_SAFETY.md, architecture/EXECUTION_MODEL.md, architecture/MODULES.md"
        ;;
    *apps/web/src/modules/registry.ts|*apps/web/src/core/Shell.tsx)
        relevant_docs="architecture/FRONTEND_INFORMATION_ARCHITECTURE.md, modules/product-shell.md, modules/frontend-layout.md, architecture/CURRENT_REPO_SUMMARY.md"
        ;;
    *apps/web/src/modules/*)
        relevant_docs="architecture/FRONTEND_INFORMATION_ARCHITECTURE.md, modules/product-shell.md, modules/frontend-layout.md"
        ;;
    *packages/protocol/src/*)
        relevant_docs="architecture/PROTOCOL_FOUNDATION.md, modules/client-server-protocol.md, architecture/CURRENT_REPO_SUMMARY.md"
        ;;
esac

# Filename fallbacks for common structural files outside the path-specific map.
if [[ -z "$relevant_docs" ]]; then
    case "$basename_file" in
        Dockerfile)
            relevant_docs="architecture/OPERATIONS_AND_SAFETY.md, COMMANDS.md, architecture/CURRENT_REPO_SUMMARY.md"
            ;;
        package.json|package-lock.json)
            relevant_docs="COMMANDS.md, architecture/CURRENT_REPO_SUMMARY.md"
            ;;
        context-bundles.yaml)
            relevant_docs="INDEX.md, BOUNDARIES.md"
            ;;
    esac
fi

if [[ -n "$relevant_docs" ]]; then
    echo ""
    echo "╔─ DOCS SYNC REMINDER ──────────────────────────────────────────╗"
    echo "│ '$file_path' was edited."
    echo "│ Review these .agent/ docs if the change affects their content:"
    echo "│"
    IFS=',' read -ra docs <<< "$relevant_docs"
    for doc in "${docs[@]}"; do
        echo "│   .agent/${doc# }"
    done
    echo "│"
    echo "│ Also check: .agent/tasks/current-focus.md (if status changed)"
    echo "╚───────────────────────────────────────────────────────────────╝"
fi

exit 0
