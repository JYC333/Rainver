import { describe, expect, it } from "vitest";
import { connectionError } from "../src/connectionError.js";

describe("connection diagnostics", () => {
  it.each([
    ["EAI_AGAIN", "DNS resolution failed"], ["ENOTFOUND", "DNS resolution failed"],
    ["ECONNREFUSED", "Connection refused"], ["EACCES", "permissions"],
    ["UND_ERR_CONNECT_TIMEOUT", "timed out"], ["CERT_HAS_EXPIRED", "TLS verification failed"],
  ])("explains %s without claiming the Host is offline", (code, reason) => {
    const result = connectionError(new Error("fetch failed", { cause: { code } }));
    expect(result).toContain(code);
    expect(result).toContain(reason);
    expect(result).toContain("does not establish");
  });
  it("handles aggregate causes and never exposes their URLs or credentials", () => {
    const error = new AggregateError([{ code: "ECONNREFUSED", message: "https://user:secret@example.com?token=private" }], "token=private");
    expect(connectionError(error)).toContain("ECONNREFUSED");
    expect(connectionError(error)).not.toMatch(/secret|private|example/);
  });
});
