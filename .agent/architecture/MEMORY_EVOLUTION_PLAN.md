# Memory Evolution Plan

This file no longer holds a forward-looking plan.

**Current state**
- Knowledge retrieval (lexical, graph, vector/ANN, rerank, rewrite, synthesis)
  is documented in
  [CONTEXT_AND_RETRIEVAL_LAYER.md](CONTEXT_AND_RETRIEVAL_LAYER.md).
- Memory maintenance scans, packets, and child proposals are documented in
  [MEMORY_MAINTENANCE.md](MEMORY_MAINTENANCE.md).
- Memory write, ACL, and Runtime Context acquisition rules are unchanged:
  [MEMORY_MODEL.md](MEMORY_MODEL.md),
  [MEMORY_CONTEXT_RUNTIME.md](MEMORY_CONTEXT_RUNTIME.md),
  [ADR 0003](../decisions/0003-memory-proposal-flow.md).

**Unimplemented Memory-quality ideas** (duplicate clustering, Memory-arm
ranking, Knowledge-to-Memory promotion, context-digest maturity, Personal
Radius) live in
[../plans/unimplemented-from-guides.md](../plans/unimplemented-from-guides.md)
§9.
