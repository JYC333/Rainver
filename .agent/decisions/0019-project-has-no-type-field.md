# ADR 0019: A Project Has No Type Field

Date: 2026-09-03

## Status

Accepted.

Current state lives in [`architecture/PROJECTS.md`](../architecture/PROJECTS.md)
(the Project kernel), [`architecture/PROJECT_WORK.md`](../architecture/PROJECT_WORK.md)
(the Loop and the Board) and [`modules/rooms.md`](../modules/rooms.md) (how a
conversation advances a Project). This document holds the decision and its
reasoning only.

## Context

`projects.primary_mode` was the system's "one classification axis": how a
Project advances — `research`, `delivery`, `operations`, `learning` — chosen
at creation and changed from Settings, with an append-only transition log.
Every earlier capability it carried had already been removed for changing no
behaviour: the per-Mode projection, the per-Mode placeholder rows, the Project
Template that once presets it. What was left read it in exactly one place, to
pick one of four wordings for the same five Loop stages.

Meanwhile every Project was in fact research-shaped, and not because of the
field. The web created every Project as `research` with no chooser; the
continuation after an accepted definition always decomposed the goal into
three to five research questions; the Room's policies named only research
verbs. A Project whose goal was "add asset management to the finance system"
got five research questions and an empty Board. The mode field neither caused
that nor could fix it: making it real would have meant one continuation, one
policy set and one Area emphasis per mode — the machinery that had already
been removed once — and a person would still have had to know, on day one,
which of four words their work was.

The person also said what a Project is *for*: to be tracked. A starting load
the person did not ask for — five questions, or a Task per plan step — is the
opposite of tracking; it is the system setting the pace.

## Decision

1. **A Project has no type field.** `projects.primary_mode`,
   `project_brief_versions.primary_mode`, `project_mode_transitions`, the
   transition API, the Settings dropdown and the protocol schemas are removed.
   Nothing may reintroduce a stored classification of a Project. Every
   Project has the same kernel (Brief, Decisions, Instruction), the same
   objects (Task, Inquiry Thread, Research Operation, Source, Note, Files &
   Code), the same Loop, the same Board and the same Room; every Area is
   reachable from birth.

2. **What kind of work a Project is, is derived, never declared.** Two
   things already say it: the accepted Brief's goal — user-confirmed, stored,
   editable, and read by the Agent on every turn — and what the Project comes
   to hold (many Threads and Sources, or many Tasks and file changes, or
   recurring Tasks). A Project may change shape as it goes; no one switches a
   field to allow it. No surface shows a type label; the counts on Pulse and
   the Board already are the shape.

3. **The conversation advances one step at a time, at the person's pace.**
   After a definition is accepted the continuation takes exactly one next
   step, chosen from the goal: a goal that is a question opens one Inquiry
   Thread; a goal that names something to build creates the first Task. In
   ordinary turns, when the person asks for a decomposition or a plan the
   Agent creates at most three objects per turn and names the rest; when they
   did not ask, at most one. These bounds live in the Room's policy text and
   the continuation instruction, and are the only place pacing is decided.

4. **The Loop has one wording.** The five stage keys — `frame`, `plan`,
   `act`, `verify`, `conclude` — are the labels, in every Project.

5. **When a kind of work needs structure the shared model lacks** (spaced
   review for learning, an on-call rota or SLA for operations), the answer is
   a new object owned by an Area, never a mode that switches behaviour. A
   mode cannot supply structure; it can only re-word what exists.

## Consequences

- Creation presets nothing but a name and an optional Brief. The web no longer
  sends a mode; the server no longer defaults one.
- The Board reads `Frame / Plan / Act / Verify / Conclude` whatever the
  Project is about. `WORK_LOOP_STAGE_LABELS` is one table.
- The accepted-definition continuation and `QUESTION_DECOMPOSITION_ACTION_POLICY`
  / `PLAN_ACTION_POLICY` carry the pacing bounds in decision 3.
- The single-file schema baseline was rewritten; per
  `server/migrations/README.md`, a database that already applied the old
  baseline is recreated.
- Every Area stays visible from birth. Nothing governs Area visibility, and
  nothing should: three Areas are the only place their data can be created,
  so hiding one until it has data would make it unreachable forever.
- The deferred-register item to delete `primary_mode` is closed by this ADR.
