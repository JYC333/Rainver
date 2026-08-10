import { describe, it, expect, expectTypeOf } from "vitest";
import * as protocol from "../src/index";
import {
  PROTOCOL_VERSION,
  VISIBILITY_VALUES,
  AnyCommandSchema,
  AnyEventSchema,
  CommandType,
  EventType,
  ModelProviderDTOSchema,
  isCredentialChannel,
  type ActivityDTO,
  type ModelProviderDTO,
  type StartRunCommand,
  type RunStatusChangedEvent,
} from "../src/index";

describe("index smoke import", () => {
  it("re-exports the public surface from src/index.ts", () => {
    // Schemas (values)
    expect(protocol.ActivityDTOSchema).toBeDefined();
    expect(protocol.ProposalDTOSchema).toBeDefined();
    expect(protocol.RunDTOSchema).toBeDefined();
    expect(protocol.RunEventDTOSchema).toBeDefined();
    expect(protocol.ArtifactDTOSchema).toBeDefined();
    expect(protocol.MemoryDTOSchema).toBeDefined();
    expect(protocol.KnowledgeItemDTOSchema).toBeDefined();
    expect(protocol.SpaceRefSchema).toBeDefined();
    expect(protocol.UserRefSchema).toBeDefined();
    expect(protocol.AgentRefSchema).toBeDefined();
    expect(protocol.ProjectFolderRefSchema).toBeDefined();
    expect(protocol.ProjectRefSchema).toBeDefined();

    // Command + event contracts
    expect(protocol.CommandEnvelopeSchema).toBeDefined();
    expect(protocol.CreateCaptureCommandSchema).toBeDefined();
    expect(protocol.StartRunCommandSchema).toBeDefined();
    expect(protocol.AnyCommandSchema).toBeDefined();
    expect(protocol.EventEnvelopeSchema).toBeDefined();
    expect(protocol.AnyEventSchema).toBeDefined();

    // Provider + credential-channel contracts
    expect(protocol.ModelProviderDTOSchema).toBeDefined();
    expect(protocol.ModelProviderCreateRequestSchema).toBeDefined();
    expect(protocol.CredentialChannelMetadataSchema).toBeDefined();

    expect(protocol.ProviderCredentialsAuthoritySchema).toBeDefined();
    expect(protocol.RuntimeCredentialResolveRequestSchema).toBeDefined();
    expect(protocol.RuntimeHostExecuteRequestSchema).toBeDefined();
    expect(protocol.RuntimeHostExecuteResponseSchema).toBeDefined();
    expect(protocol.RuntimeContextPolicyDocumentSchema).toBeDefined();
    expect(protocol.ExecutionControlSnapshotSchema).toBeDefined();
    expect(protocol.WorkContextSetupSchema).toBeDefined();
    expect(protocol.TurnContextRequestSchema).toBeDefined();
    expect(protocol.InvocationDeliverySchema).toBeDefined();
    expect(protocol.InvocationSnapshotSafeSchema).toBeDefined();
    expect(protocol.MicroCheckpointSchema).toBeDefined();
    expect(protocol.SemanticCheckpointSchema).toBeDefined();
    expect(protocol.SemanticCheckpointExtractionSchema).toBeDefined();
    expect(protocol.RuntimeContextEventIngressSchema).toBeDefined();
    expect(protocol.AgentRunGroupSchema).toBeDefined();
    expect(protocol.RunDelegationSchema).toBeDefined();
    expect(protocol.ProposalOutSchema).toBeDefined();
    expect(protocol.ProposalAcceptOutSchema).toBeDefined();
    expect(protocol.SessionOutSchema).toBeDefined();
    expect(protocol.MessageOutSchema).toBeDefined();
    expect(protocol.MemoryOutSchema).toBeDefined();
  });

  it("exposes stable value sets", () => {
    expect(PROTOCOL_VERSION).toBe("0.0.0");
    expect(VISIBILITY_VALUES).toContain("space_shared");
    expect(CommandType.StartRun).toBe("run.start");
    expect(EventType.RunStatusChanged).toBe("run.status_changed");
    expect(isCredentialChannel("model_provider_api_key")).toBe(true);
  });

  it("exposes the discriminated unions", () => {
    expect(AnyCommandSchema.options.length).toBe(5);
    expect(AnyEventSchema.options.length).toBe(7);
  });
});

describe("type-level contracts (typecheck test)", () => {
  it("infers DTO and envelope types from schemas", () => {
    expectTypeOf<ActivityDTO>().toHaveProperty("space_id");
    expectTypeOf<ActivityDTO["space_id"]>().toEqualTypeOf<string>();
    expectTypeOf<ModelProviderDTO>().toHaveProperty("has_api_key");
    expectTypeOf<ModelProviderDTO["has_api_key"]>().toEqualTypeOf<boolean>();
    expectTypeOf<StartRunCommand["type"]>().toEqualTypeOf<"run.start">();
    expectTypeOf<RunStatusChangedEvent["type"]>().toEqualTypeOf<"run.status_changed">();
    expect(ModelProviderDTOSchema).toBeDefined();
  });
});
