import { createHash } from "node:crypto";
import {
  ACTION_RESULT_REPORTING_POLICY,
  DURABLE_ACTION_CLAIM_POLICY,
  IDENTIFIER_POLICY,
} from "../systemActions/conversationPolicy.js";

/**
 * The Rainver Work Skill: the harness contract a dispatched agent works under.
 *
 * It is a builtin skill in the sense `SkillSourceType`'s `"builtin"` already
 * means — content Rainver owns, versioned with the server rather than
 * imported, carrying no provenance, risk or approval state because there is no
 * third party to trust. It is not an enablement: a Run that has tool grants
 * gets it, with nothing to turn on and nothing that can turn it off, because a
 * Run that can act and cannot report is an error state. A Run with no grants
 * gets no Skill and no surface.
 *
 * Its content has one source. The judgement rules are the same constants
 * `ManagedAgentToolSurface` assembles for the managed loop
 * (`systemActions/conversationPolicy.ts`); only the CLI mechanics below are
 * specific to a runtime that reaches the actions over a command instead of
 * native tool calls. Two hand-maintained copies of "when to call which action"
 * is precisely the drift this arrangement exists to prevent.
 *
 * What an agent may actually call is decided elsewhere and is unchanged by
 * this file: the Run's `permission_snapshot_json.tool_grants` computed at
 * creation, enforced call by call by `SystemActionDispatcher`. The Skill says
 * so, and points at `list` rather than naming a fixed set, so a Run that was
 * granted less does not read instructions for actions it cannot invoke.
 */
export const WORK_SKILL_ID = "rainver-work";

export const WORK_SKILL_FILE_NAME = "SKILL.md";

/** Where the Skill is written, relative to the run directory the host makes. */
export const WORK_SKILL_RELATIVE_PATH = `rainver/${WORK_SKILL_FILE_NAME}`;

export interface WorkSkillOptions {
  /**
   * Whether this Run can deliver a declared output.
   *
   * `artifact.submit` and the output directory it names exist on the
   * remote-host path; a server-sandbox Run has neither, so telling it to copy
   * a file into an unset `$RAINVER_OUTPUT_DIR` and declare it would send the
   * agent through a workflow that silently writes nothing and then refuses.
   * Everything else about reporting back is identical, so everything else in
   * the Skill is.
   */
  deliverOutputs: boolean;
  /**
   * Whether this Run is a turn in a conversation with a person. Then the
   * reply *is* the message they read, and the commands record durable
   * objects alongside it; a dispatched Task has no reader for its reply at
   * all. The dispatched text told a Room agent its reply reached nobody,
   * and it answered "what should I do next?" with tool calls and a blank.
   */
  conversation?: boolean;
}

/**
 * How to hand over a deliverable, on a path that can collect one.
 *
 * A Task with declared required outputs closes automatically only when a file
 * of the declared type actually arrives, so this is the difference between an
 * agent finishing the work and the Task showing it.
 */
const OUTPUT_DELIVERY_SECTION = `
## Delivering an output

A Task can declare required outputs. It is closed automatically only when a
file of the declared type actually arrives; otherwise it waits for a person.

Two steps, both required:

\`\`\`sh
cp report.md "$RAINVER_OUTPUT_DIR/report.md"
$RAINVER_CLI call artifact.submit '{"task_id":"<from task.list>","path":"report.md","artifact_type":"report","role":"output"}'
\`\`\`

- Write the file into \`$RAINVER_OUTPUT_DIR\` and declare its \`path\`
  **relative to that directory**. Files elsewhere are not collected as
  deliverables — ordinary work still belongs in the workspace, and its changes
  are captured separately.
- \`artifact_type\` must match what the Task declares, or the Task will not
  close.
- Declaring does not upload. The file is collected from disk after you exit,
  so leave it in place.
`;

export function renderWorkSkill(options: WorkSkillOptions = { deliverOutputs: true }): string {
  return `---
name: ${WORK_SKILL_ID}
description: How to read the work you were given and report back to Rainver.
---

# Working for Rainver

${options.conversation
  ? `You are talking with a person inside a Rainver Project.
Your reply is the message they read. Rainver also holds the Project's record
— its goal, Tasks, questions and proposals — and only the commands below write
to it: a goal or a plan that exists only in your reply is not recorded.`
  : `You were dispatched by Rainver to advance a piece of work it is tracking.
Rainver holds the Task, its context and its record; you do the work and tell
Rainver what happened. Nothing you write in your reply reaches it — only the
commands below do.`}

## The command

\`$RAINVER_CLI\` is an absolute path to the \`rainver\` command, already
configured with this run's identity. Three subcommands:

\`\`\`sh
$RAINVER_CLI list                      # the actions this run may call
$RAINVER_CLI describe <action>         # one action's JSON input schema
$RAINVER_CLI call <action> '<json>'    # invoke it; prints the JSON result
\`\`\`

\`call\` also accepts \`@file.json\` or \`-\` (stdin) instead of an inline
argument, which is what to use when the payload contains quotes or newlines.
It exits non-zero and prints the reason when an action is refused or fails.

**Start by running \`list\`.** It is authoritative: an action absent from it is
not available to you in this run, whatever this document mentions. Run
\`describe\` before the first call of any action rather than guessing its
fields.

${options.conversation
  ? `## What to do

1. \`list\` first. Read the Project's state before recommending anything:
   \`call task.list '{}'\` (status, priority, due dates, blockers) and
   \`call inquiry.list_threads '{}'\` (each Thread's recorded next step).
2. When the person states the Project's goal, \`call project.propose_definition\`;
   when they ask for a plan or next steps, create each step with
   \`task.create\` (timing goes in \`due_at\` / \`start_after\`); when they
   accept or reject a proposal, \`proposal.list_pending\` then \`proposal.decide\`.
3. Answer them in your reply: what you recorded, what awaits their decision,
   and what you recommend. Never claim a write you did not make.`
  : `## What to do, in order

1. \`list\`, then \`call task.list '{}'\` to see the Tasks and their ids.
2. Do the work.
3. Report what happened with \`task.report\` — at least once when you finish,
   and on any meaningful intermediate result. This is the only account a
   person will read.
4. If you need a person to decide something, \`task.request_review\` and stop.
   Do not guess and continue.`}
${options.deliverOutputs ? OUTPUT_DELIVERY_SECTION : ""}
## Rules

${IDENTIFIER_POLICY}

${DURABLE_ACTION_CLAIM_POLICY}

${ACTION_RESULT_REPORTING_POLICY}

A write you are able to make is a write a person asked for: make it, do not
ask for confirmation, and do not describe it as pending. Every one of them is
visible to the person afterwards with a one-click undo. Keep any fan-out to at
most five per turn, and never raise a limit an action documents on your own
initiative.
`;
}

/**
 * The quick reference the dispatched prompt carries.
 *
 * The pointer has to be in the prompt because there is no vendor-neutral way
 * to make a runtime discover a file on its own: every mechanism that would
 * (a vendor's skills directory) also moves that vendor's login state, which
 * for an unbound run is the machine's own and must stay where it is
 * (ADR 0016 §4). Keeping a few lines inline rather than only the path means an
 * agent that never opens the file still reports back.
 */
export function workSkillPromptPointer(
  skillPath: string,
  options: WorkSkillOptions = { deliverOutputs: true },
): string {
  return [
    "## Reporting back to Rainver",
    "",
    `Read \`${skillPath}\` before you start — it is the contract for this run.`,
    "In short: `$RAINVER_CLI list` shows the actions you may call,",
    "`$RAINVER_CLI describe <action>` gives one its input schema, and",
    "`$RAINVER_CLI call <action> '<json>'` invokes it.",
    ...(options.conversation
      ? [
          "Use `task.list` and `inquiry.list_threads` to read the Project before recommending,",
          "`project.propose_definition` when the person states the goal, `task.create` for each",
          "step of a plan, and `proposal.decide` when they accept or reject a proposal.",
          "Your reply is the message they read; only these calls change the Project's record.",
        ]
      : [
          "Use `task.list` for Task ids,",
          "`task.report` to say what happened,",
          ...(options.deliverOutputs
            ? ["`artifact.submit` to declare a deliverable you wrote into `$RAINVER_OUTPUT_DIR`,"]
            : []),
          "and `task.request_review` to hand a decision back.",
          "Your reply text reaches nobody; only these calls do.",
        ]),
  ].join("\n");
}

/**
 * Which Skill a Run received.
 *
 * The Skill changes what an agent does the way a prompt does, so explaining a
 * Run later needs the exact text it saw. The content is code, versioned by
 * git, so a hash identifies it without storing a copy per Run.
 */
export function workSkillContentHash(content: string = renderWorkSkill()): string {
  return createHash("sha256").update(content).digest("hex");
}
