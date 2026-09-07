import { describe, expect, it } from "vitest";
import { HostServerFrameSchema, LOGIN_INPUT_MAX_CHARS } from "../src/hostWire.js";

describe("login_input frame", () => {
  it("carries at most LOGIN_INPUT_MAX_CHARS, so the daemon never sees a larger one", () => {
    const frame = (data: string) => HostServerFrameSchema.safeParse({ type: "login_input", session_id: "s1", data });
    expect(frame("x".repeat(LOGIN_INPUT_MAX_CHARS)).success).toBe(true);
    expect(frame("x".repeat(LOGIN_INPUT_MAX_CHARS + 1)).success).toBe(false);
  });
});
