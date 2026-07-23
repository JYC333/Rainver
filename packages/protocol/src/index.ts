/**
 * @agent-space/protocol — shared, framework-free wire contracts.
 *
 * This is the single public entry point. It re-exports the protocol's
 * primitives, DTOs, command contracts and event contracts. It owns **schemas and
 * types only** — no handlers, no transport, no business logic, no authority.
 * Authority is owned by the runtime service that registers each route; this
 * package only describes the wire contracts.
 *
 * The package depends only on `zod`. Importing it must never pull in frontend,
 * backend, database, or runtime code. See
 * `.agent/architecture/PROTOCOL_FOUNDATION.md`.
 */

// Primitives + value sets
export * from "./common.js";

// Zod schemas (single source of truth for data shapes)
export * from "./schemas.js";

// Inferred DTO types
export * from "./dto.js";

// Command contracts (schemas + types)
export * from "./commands.js";

// Event contracts (schemas + types)
export * from "./events.js";

// Canonical model contracts (request/message/usage + streaming events)
export * from "./model.js";

// Provider + credential-channel contracts
export * from "./providers.js";

// CLI credential-channel contracts
export * from "./credentials.js";

// Network profile contracts
export * from "./networkProfiles.js";

// Identity introspection contract
export * from "./auth.js";

// Provider DB read allowlist
export * from "./providersDb.js";

// Provider and credential runtime boundary contracts
export * from "./providerCredentialsRuntime.js";

// Runtime-host boundary contracts
export * from "./runtimeHost.js";

// Token usage metering contracts
export * from "./usage.js";

// Targeted cross-space publication snapshots and imports
export * from "./publications.js";

// Run orchestration contracts
export * from "./runOrchestration.js";

// Agent group run / delegation contracts
export * from "./agentGroupRuns.js";

// Policy enforcement contracts
export * from "./policy.js";

// Registry-driven System Action contracts
export * from "./systemActions.js";

// Proposal review contracts
export * from "./proposals.js";

// Knowledge retrieval contracts
export * from "./knowledgeRetrieval.js";

// Knowledge object and proposal packet contracts
export * from "./knowledge.js";

// Project public summary contracts
export * from "./projects.js";

// Memory + sessions contracts
export * from "./memorySessions.js";

// Context workspace/profile contracts
export * from "./contextProfiles.js";

// Context Ops read-model contracts
export * from "./contextOps.js";

// Ask Space unified entry-point contracts
export * from "./askSpace.js";

// Claim trajectory + contradiction loop contracts (Slice E)
export * from "./claimReviewLoop.js";

// Candidate-relation discovery pipeline contracts (Slice F)
export * from "./relationDiscovery.js";

// Graph projection rendering contract
export * from "./graphProjection.js";

// Object schema / Object Schema Registry contracts
export * from "./objectSchema.js";

// Official Optional Module (plugin) control-plane contracts
export * from "./plugins.js";

// Capability / workflow / Open Skill framework contracts
export * from "./capabilities.js";
export * from "./workflows.js";
export * from "./skills.js";
export * from "./projectResearch.js";
export * from "./researchDiscovery.js";
export * from "./reader.js";

// Source provider / connector / search channel contracts
export * from "./sourceChannels.js";

// Source Custom Source handler contracts
export * from "./sourceCustomSourceHandlers.js";

// Source Level 2 Source recipe contracts
export * from "./sourceRecipes.js";

// Centralized prompt registry contracts
export * from "./prompts.js";
