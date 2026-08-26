# ADR 0010 — Personal + Small-Team Agent Workbench Direction

Date: 2026-07-11
Status: accepted

## Decision

For the next two quarters, Rainver is a **server-authoritative Agent Workbench for
individuals, households, and small teams**. It is intended to carry substantial daily work:
research, writing, knowledge synthesis, project execution, recurring workflows, automation,
and code work.

The product does not begin as single-user software with collaboration deferred. Personal,
household, and small-team spaces are first-order product contexts from the start. Shared
tasks and work products, member permissions, private-versus-shared context, and auditable
human/agent collaboration are core product requirements.

Memory, Knowledge, Context, Sources, Artifacts, Tasks, and Proposals are the workbench's
durable substrate. Agent orchestration and automation are execution capabilities. Controlled
self-evolution is a supporting internal capability, not the primary product identity.

## Runtime stance

OpenCode is a **third optional CLI runtime**, alongside Claude Code and Codex CLI. It is not
the preferred universal runtime, does not replace the managed API path, and does not impose a
Router preference order. Rainver retains all product authority and governance.

CLI subscription capacity and paid APIs remain dual primary funding/access paths selected by
task shape rather than by a universal API-first rule.

- Subscription usage is a real product resource for substantial user-initiated or
  user-supervised work.
- Claude Pro/Max subscription capacity uses native Claude Code. OpenCode's provider
  documentation records that Anthropic prohibits using those subscriptions through OpenCode.
- ChatGPT Plus/Pro may use native Codex or OpenCode while their official support remains
  available; neither receives a global Router preference from this ADR.
- Managed API work continues through the existing `model_api` / `ts_agent_host` and provider
  invocation architecture. This ADR does not require API calls to be routed through OpenCode.
- OpenCode may support API-backed providers as an adapter capability when C1.5 is implemented,
  but that is scoped adapter work, not a new universal proxy/SDK control plane.
- Provider capability, available subscription allowance, API cost, latency, sandbox level,
  audit needs, and vendor terms all participate in routing decisions.
- No core workbench authority may depend on OpenCode or one vendor CLI. OpenCode, Claude
  Code, Codex, and managed adapters remain independently disableable.
- Consumer CLI credentials remain isolated through CredentialBroker. Subscription sessions
  are not converted into ambient API credentials or shared across users.
- Unattended programmatic driving of a consumer subscription is not assumed to be permitted merely
  because interactive subscription use is supported. Where vendor terms are ambiguous or
  restrictive, the unattended path uses the vendor's API/SDK or remains disabled.

## Vendor-terms checkpoint (2026-07-11)

- Anthropic documentation explicitly supports Claude Code with Claude Pro/Max subscriptions.
  Anthropic's Skills guidance recommends API surfaces for programmatic Skills applications
  and automated pipelines, but that is a surface recommendation for Skills—not a general
  Claude Code CLI terms prohibition. The conservative unattended routing rule is an
  engineering choice where broader CLI permission remains ambiguous.
- OpenAI documentation explicitly includes Codex usage in eligible ChatGPT plans. OpenAI's
  consumer Terms of Use also restrict automatic/programmatic extraction of data or output,
  so a consumer Codex subscription is not treated as blanket permission to operate an
  unattended backend or extraction service.
- OpenCode officially exposes CLI/headless integration and multiple providers. Its provider
  documentation supports ChatGPT Plus/Pro login and API keys, while recording that Anthropic
  prohibits Claude Pro/Max subscription use through OpenCode.

This is an engineering posture, not legal advice. Recheck current official terms before
shipping a new unattended consumer-CLI workflow and keep a per-adapter kill switch.

Official sources checked for this decision:

- [Anthropic: Set up Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- [Anthropic: The Complete Guide to Building Skills for Claude](https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf)
- [OpenAI: Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan/)
- [OpenAI: Terms of Use](https://openai.com/policies/terms-of-use/)
- [OpenCode: Server](https://opencode.ai/docs/server/)
- [OpenCode: Providers](https://opencode.ai/docs/providers)

## Dogfooding checkpoint

The direction is validated only if all of the following hold for a rolling 30-day period:

1. The instance is used on each of 30 consecutive days for real work, not synthetic demos.
2. At least two human members use it during the period, and each is active in at least two
   separate weeks.
3. The workbench produces at least three substantial outcomes per week. A substantial outcome
   is a completed research/writing/code/project artifact, an executed recurring workflow, or
   another durable result that would otherwise have required meaningful manual work.
4. At least one shared-space workflow or handoff is completed per week.
5. At least one friction-driven product fix is completed per week and linked to an observed
   real-use problem.
6. The checkpoint is reviewed monthly. Missing any criterion means the product loop is not
   yet validated; platform expansion does not count as a substitute.

## Consequences

- Product prioritization favors end-to-end work outcomes and shared-space usability over
  isolated infrastructure breadth.
- Personal privacy remains first-class inside household/team deployments; shared membership
  never implies all personal context becomes shared.
- The memory system is evaluated by how well it supports ongoing work, not by memory volume.
- Runtime work should implement the planned OpenCode adapter as the third CLI runtime in
  C1.5. Routing must expose allowance/cost/failure state without conflating subscriptions
  with API spend, but this ADR defines no global OpenCode-first ordering.
- Self-evolution stays subordinate to human-reviewed workbench reliability and real use.
