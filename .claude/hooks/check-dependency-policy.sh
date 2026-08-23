#!/usr/bin/env bash
# PreToolUse hook — the Reuse/Dependency Policy gate at the moment a dependency
# is actually introduced.
#
# Deliberately narrow. It fires only on package.json edits, and only when the
# edit introduces a package *name* the manifest did not already have — a version
# bump keeps the same name and is ignored. Everything else about the policy
# (did the agent search first? was the evaluation any good?) is unverifiable by
# any hook and is left to review, per
# .agent/architecture/REUSE_AND_DEPENDENCY_POLICY.md §11.
#
# server/package.json blocks (exit 2) until the package is recorded in the
# policy's canonical mechanism index — the same condition
# server/test/agentGuides.test.ts enforces in CI, so the block is always
# satisfiable and never contradicts the suite. Other manifests warn only.
#
# Claude Code passes tool input as JSON on stdin:
#   {"tool_name": "Edit", "tool_input": {"file_path": "...", ...}}
# Exit 0 = allow (stdout is shown). Exit 2 = block (stderr goes to the model).

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
input=$(cat)

result=$(printf '%s' "$input" | REPO_ROOT="$repo_root" python3 -c '
import json, os, re, sys

POLICY = ".agent/architecture/REUSE_AND_DEPENDENCY_POLICY.md"
ALLOWLIST = "server/test/boundaries.test.ts"

# "name": "version-ish" — a script value ("tsc -p tsconfig.json") does not match.
DEP_LINE = re.compile(
    r"""["\047](@?[a-z0-9][\w.\-/]*)["\047]\s*:\s*["\047]"""
    r"""((?:[\^~>=<]|\d|\*|workspace:|catalog:|npm:|file:|link:|portal:)[^"\047]*)["\047]""",
    re.IGNORECASE,
)

def names(text):
    return {m.group(1) for m in DEP_LINE.finditer(text or "")}

def fail(msg=""):
    print(json.dumps({"action": "allow", "note": msg}))
    sys.exit(0)

try:
    payload = json.load(sys.stdin)
except Exception:
    fail()

root = os.environ["REPO_ROOT"]
tool_input = payload.get("tool_input") or {}
path = tool_input.get("file_path") or ""
if os.path.basename(path) != "package.json":
    fail()

try:
    existing = names(open(path, encoding="utf-8").read())
except OSError:
    existing = set()

# Write replaces the file wholesale; Edit supplies a fragment.
proposed = names(tool_input.get("content") or tool_input.get("new_string") or "")
introduced = sorted(proposed - existing - names(tool_input.get("old_string") or ""))
if not introduced:
    fail()

def recorded(name):
    for rel in (POLICY, ALLOWLIST):
        try:
            if name in open(os.path.join(root, rel), encoding="utf-8").read():
                return True
        except OSError:
            pass
    return False

is_server = os.path.abspath(path) == os.path.join(root, "server", "package.json")
unrecorded = [n for n in introduced if not recorded(n)]

print(json.dumps({
    "action": "block" if (is_server and unrecorded) else "warn",
    "introduced": introduced,
    "unrecorded": unrecorded,
    "manifest": os.path.relpath(os.path.abspath(path), root),
}))
' 2>/dev/null) || exit 0

fields=$(printf '%s' "$result" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('action', ''))
print(', '.join(d.get('introduced', [])))
print(', '.join(d.get('unrecorded', [])))
print(d.get('manifest', ''))
" 2>/dev/null) || exit 0

# Command substitution strips trailing newlines, so the later fields can be
# absent entirely on the allow path; `|| true` keeps `set -e` out of it.
{ read -r action || true; read -r introduced || true; read -r unrecorded || true; read -r manifest || true; } <<< "$fields"
[[ "$action" == "allow" || -z "$action" ]] && exit 0

if [[ "$action" == "block" ]]; then
    cat >&2 <<MSG
BLOCKED — new server dependency not recorded: ${unrecorded}

${manifest} would gain: ${introduced}

.agent/architecture/REUSE_AND_DEPENDENCY_POLICY.md applies here. Before re-running
this edit, complete all three:

  1. §4 evaluation — maturity, maintenance, API stability, Node 24 / ESM-CJS fit,
     security record, license, transitive cost, authority fit, and whether it
     actually deletes maintenance burden. Record the verdict where the change
     lives (plan, ADR, or architecture doc).
  2. §5 — add a row for it to the canonical mechanism index. This is the same
     condition server/test/agentGuides.test.ts enforces in CI; skipping it here
     only moves the failure later.
  3. server/test/boundaries.test.ts — add it to ALLOWED_BARE, or preferably to
     ALLOWED_BARE_BY_FILE so it cannot spread past the module that needs it.

If the answer is that the repository already has a mechanism for this concern,
the right edit is not this one. Check §5 first.
MSG
    exit 2
fi

cat <<MSG

── REUSE / DEPENDENCY CHECK ──────────────────────────────────────
 ${manifest} gains: ${introduced}

 .agent/architecture/REUSE_AND_DEPENDENCY_POLICY.md §4 applies.
 Confirm before moving on:
   · does the repo already have a mechanism for this concern? (§5)
   · maintenance, license, API stability, transitive cost, authority fit
   · does adopting it actually delete maintenance burden?
──────────────────────────────────────────────────────────────────
MSG
exit 0
