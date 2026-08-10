# Protocol / Client Contract Drift

Date: 2026-08-08
Status: designed enough to size, not started. No trigger required — the
duplication is measured below and is not hypothetical.

Split out of
[hardening-blind-spot-remediation-plan.md](hardening-blind-spot-remediation-plan.md),
where it had been carried since 2026-07-24 as a feasibility gate. The gate ran,
decided "not ready, proceed with matching manual edits", and the Project clean
cutover it was gating shipped. What outlived the gate is the commitment it made
and nobody kept: **add a test that fails when a protocol DTO and its `apps/web`
counterpart diverge.**

## The measurement

`packages/protocol/src/*.ts` and `apps/web/src/types/api.ts` declare **210 type
names in common**, each side independently:

| | count |
|---|---|
| protocol `type` ↔ web `interface` | 159 |
| protocol `type` ↔ web `type` | 51 |
| genuinely re-exported from protocol | 16 |

The re-exported 16 are the only ones that cannot drift. The other 210 are two
hand-maintained declarations of the same wire shape with nothing comparing
them. `apps/web/src/types/api.ts` is 6,388 lines; `packages/protocol/src` is
12,560.

Whether any have *already* diverged is unknown, and finding out is part of the
work: the two sides declare differently — protocol infers from zod schemas,
the web hand-writes interfaces — so a textual or field-name comparison finds
nothing. The comparison has to happen at the TypeScript type level.

## What has to be decided

Recorded as questions, not answers, because the shape of the work depends on
them and picking one now would be guessing.

1. **Assertion or generation.** A per-type bidirectional assignability check
   (`const _a: Protocol.X = {} as Web.X` and the reverse) is mechanical, needs
   no new tooling, and fails at `tsc` — but it is ~210 entries someone has to
   keep in step, which is the same maintenance problem one layer up. Generating
   `api.ts` from the protocol package removes the duplicate instead of checking
   it, but the repo has no codegen step today and adding one is real tooling.
2. **Direction of authority.** If generation wins, protocol is the source and
   the web's hand-written interfaces go away. If assertion wins, both stay and
   the test only proves they agree — which is the weaker outcome, and the one
   B12G would call a fork with a guard rather than a shared declaration.
3. **Scope.** All 210, or the subset carried on routes that actually change?
   The full set is honest but large; a subset needs a rule for what is in.
4. **Whether the duplication is even wanted.** Some client types are genuinely
   client-only view models that merely happen to share a name. Those should be
   renamed rather than reconciled, and telling them apart is manual.

## Why it is not urgent

No contract-drift bug has been observed. The original trigger language — "full
client generation remains triggered by a second real contract-drift bug or
demonstrated maintenance cost" — is still the honest read of the risk, which is
why this is its own file rather than an item in an active sequence.

What changed is that the size is now measured instead of estimated, so the next
person deciding does not have to re-derive it.

## Out of scope

- Rewriting the client's own view models that do not correspond to a wire DTO.
- Introducing a codegen pipeline as a side effect of some other change.
