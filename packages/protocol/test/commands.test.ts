import { describe, it, expect } from "vitest";
import {
  CommandEnvelopeSchema,
  CreateCaptureCommandSchema,
  ApproveProposalCommandSchema,
  StartRunCommandSchema,
  AnyCommandSchema,
  CommandType,
} from "../src/commands";

const base = {
  command_id: "c1",
  issued_at: "2026-06-09T12:00:00+00:00",
};

describe("command contracts", () => {
  it("parses the generic envelope with an unknown payload", () => {
    const env = CommandEnvelopeSchema.parse({
      ...base,
      type: "anything",
      payload: { whatever: true },
    });
    expect(env.type).toBe("anything");
  });

  it("parses a CreateCaptureCommand", () => {
    const cmd = CreateCaptureCommandSchema.parse({
      ...base,
      type: CommandType.CreateCapture,
      payload: { space_id: "s1", activity_type: "user_capture", content: "hi" },
    });
    expect(cmd.type).toBe("activity.capture.create");
    expect(cmd.payload.space_id).toBe("s1");
  });

  it("rejects a command whose literal type does not match", () => {
    const result = ApproveProposalCommandSchema.safeParse({
      ...base,
      type: "run.start", // wrong literal
      payload: { space_id: "s1", proposal_id: "p1" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a StartRunCommand with a malformed payload", () => {
    const result = StartRunCommandSchema.safeParse({
      ...base,
      type: CommandType.StartRun,
      payload: { space_id: "s1" }, // missing agent_id
    });
    expect(result.success).toBe(false);
  });

  it("routes via the discriminated union on `type`", () => {
    const parsed = AnyCommandSchema.parse({
      ...base,
      type: CommandType.StartRun,
      payload: { space_id: "s1", agent_id: "ag1", instruction: "go" },
    });
    expect(parsed.type).toBe("run.start");
    if (parsed.type === "run.start") {
      expect(parsed.payload.agent_id).toBe("ag1");
    }
  });
});
