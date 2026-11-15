# Plan 5 — Core Module Migration (retired)

Completed within P5 scope on 2026-11-14. The temporary execution ledger is
retired; this file remains as the stable entry for existing links. Its full
history is preserved in Git at `a37ed3b36ca475a91d1fa870429ca1b2ba2daf09`.
Do not use old partial counts or pending-review checkpoints as current status.

The original three batches remain **23 + 41 + 26 = 90**. Activity upload was
one separate correction; daemon workspace create/remove and instance-admin
enable/disable were four further corrections. Implementation and corrections
passed the coordinated Claude/Antigravity reviews and landed on dev.

Final inventory: **630 = 575 core + 15 P4 legacy + 40 protocol exemptions**.
P5 has no remaining legacy entry; Diary/Finance's fifteen belong to P4.

Current authorities:

- [Execution contract](../../architecture/OPERATION_EXECUTION_CONTRACT.md):
  actor, authorization, idempotency, transaction and Job ownership boundaries.
- [System Actions](../../architecture/SYSTEM_ACTIONS.md): registered operations
  and retained entry adapters.
- [P5 acceptance and limits](../../architecture/OPERATION_CORE_ACCEPTANCE.md#p5-closeout):
  review/verification evidence, protocol-owner exemptions, GET corrections and
  explicit limitations, including conservative upload residue on crash/DB loss.
- [Program index](README.md): remaining work outside P5.

No deployment, full-suite/browser/stress pass or whole-program completion is
implied. Historical commands and coordination handoffs are not a new work queue.
