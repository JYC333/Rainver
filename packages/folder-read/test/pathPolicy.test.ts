import { describe, expect, it } from "vitest";
import { isWireRelativePath, redactLocalPaths, redactSecretLikeDiff, validatePath } from "../src/pathPolicy.js";

describe("folder-read path policy", () => {
  it("keeps absolute paths off the server-daemon wire while leaving traversal to root policy", () => {
    expect(isWireRelativePath("src/../README.md")).toBe(true);
    expect(isWireRelativePath(".")).toBe(true);
    expect(isWireRelativePath("/Users/alice/private")).toBe(false);
    expect(isWireRelativePath("C:\\Users\\alice\\private")).toBe(false);
    expect(isWireRelativePath("\\\\server\\share")).toBe(false);
  });

  it("rejects traversal and secret-like paths", () => {
    expect(() => validatePath({ path: "/workspace/../secret.txt", allowedRoot: "/workspace" }))
      .toThrow(/Path traversal denied/);
    expect(() => validatePath({ path: "/workspace/.env", allowedRoot: "/workspace" }))
      .toThrow(/forbidden/);
    expect(() => validatePath({ path: "/workspace/config/secrets/token.txt", allowedRoot: "/workspace" }))
      .toThrow(/config\/secrets/);
  });

  it("allows env templates and requires code_patch for direct script writes", () => {
    expect(validatePath({ path: "/workspace/.env.example", allowedRoot: "/workspace" }))
      .toBe("/workspace/.env.example");
    expect(() => validatePath({ path: "/workspace/tool.sh", allowedRoot: "/workspace", mode: "write" }))
      .toThrow(/code_patch Proposal/);
    expect(validatePath({
      path: "/workspace/tool.sh",
      allowedRoot: "/workspace",
      mode: "write",
      forTrustedCodePatchApply: true,
    })).toBe("/workspace/tool.sh");
  });

  it("blocks direct .git access in a protected Folder", () => {
    expect(() => validatePath({
      path: "/workspace/.git/config",
      allowedRoot: "/workspace",
      protectedFolder: true,
    })).toThrow(/\.git/);
  });

  it("redacts quoted and JSON-shaped secret values", () => {
    const result = redactSecretLikeDiff([
      'api_key="quoted-secret"',
      "password: 'quoted-password'",
      '{"token":"json-secret"}',
      String.raw`+{"token":"abc\\"def"}`,
    ].join("\n"));
    expect(result.redacted).toBe(true);
    expect(result.diff).not.toContain("quoted-secret");
    expect(result.diff).not.toContain("quoted-password");
    expect(result.diff).not.toContain("json-secret");
    expect(result.diff).not.toContain("abc");
    expect(result.diff).not.toContain("def");
  });

  /**
   * `\b` does not fire between `_` and a letter, so a pattern written
   * `\b(token|secret)\b` matched neither `access_token` nor `client_secret` —
   * the two spellings most likely to appear in real source. The server's copy
   * of this rule was fixed; this one, which runs on the daemon and feeds both
   * the Files & Code reader and the persisted `remote_diff`, was not.
   */
  it("redacts a credential word anywhere in the name, not only at a word boundary", () => {
    const result = redactSecretLikeDiff([
      '+export const ACCESS_TOKEN = "ghp_AAAABBBBCCCCDDDD"',
      '+const access_token = "sk-ant-api03-REALSECRET12345"',
      '+const client_secret = "GOCSPX-xxxxxxxxxxxx"',
      "+MY_API_KEY=AIzaSyAAAABBBBCCCC",
      '+const refresh_token = "rt-REALSECRET"',
      '+x-api-key: "hdr-REALSECRET"',
    ].join("\n"));
    expect(result.redacted).toBe(true);
    for (const secret of ["ghp_AAAABBBBCCCCDDDD", "REALSECRET12345", "GOCSPX-xxxxxxxxxxxx", "AIzaSyAAAABBBBCCCC", "rt-REALSECRET", "hdr-REALSECRET"]) {
      expect(result.diff, secret).not.toContain(secret);
    }
    // The field name survives, so the reader can still see what was there.
    expect(result.diff).toContain("access_token");
    expect(result.diff).toContain("client_secret");
  });

  it("redacts a credential whose variable name gives nothing away", () => {
    // The ordinary way an API key is hard-coded. No rule about names sees it.
    const result = redactSecretLikeDiff([
      '+const key = "sk-proj-ZZZZYYYYXXXX"',
      "+Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sigsigsig",
      '+const c = "ghp_QQQQWWWWEEEERRRRTTTT"',
    ].join("\n"));
    expect(result.redacted).toBe(true);
    for (const secret of ["sk-proj-ZZZZYYYYXXXX", "eyJhbGciOiJIUzI1NiJ9", "ghp_QQQQWWWWEEEERRRRTTTT"]) {
      expect(result.diff, secret).not.toContain(secret);
    }
  });

  it("agrees with the server's rule on a placeholder value and a bare query key", () => {
    // The two implementations say "change both together"; these are the two
    // places they had silently drifted apart. A value that says a credential is
    // *absent* is left alone — redacting `password: none` hides the answer and
    // protects nothing — and a hard-coded `?key=` has neither a credential word
    // in front of it nor a recognisable shape.
    const placeholders = ["password: absent", "secret = none", "api_key: null"].join("\n");
    expect(redactSecretLikeDiff(placeholders).diff).toBe(placeholders);

    const queryKey = redactSecretLikeDiff('+const url = "https://api.example.com/v1?key=OPAQUEKEY"');
    expect(queryKey.redacted).toBe(true);
    expect(queryKey.diff).not.toContain("OPAQUEKEY");
  });

  it("redacts a structured value whole, and an empty one not at all", () => {
    // Scanning a scalar out of a list left the rest dangling:
    // `secrets: [1,2]` came out as `secrets:[REDACTED],2]`, which is a mangled
    // diff rather than a redacted one. Whole, because the alternative is
    // deciding which element of `api_key: ["…"]` is the credential.
    for (const [input, expected] of [
      ['+  secrets: [1,2]', '+  secrets:[REDACTED]'],
      ['+  api_key: ["realkey123456"]', '+  api_key:[REDACTED]'],
      ['+  api_key: {"k": "realkey123456"}', '+  api_key:[REDACTED]'],
    ] as const) {
      expect(redactSecretLikeDiff(input).diff, input).toBe(expected);
    }
    // Nothing inside is nothing to hide.
    for (const empty of ['+  credentials: []', '+  token: {}', '+  secrets: [ ]']) {
      expect(redactSecretLikeDiff(empty).diff, empty).toBe(empty);
    }
  });

  it("leaves ordinary code and usage counts alone", () => {
    const kept = [
      "+  input_tokens = 1204",
      "+  max_tokens: 4096",
      "+  total_tokens = 51200",
      '+const greeting = "hello world"',
      "+function tokenize(text) {",
    ].join("\n");
    const result = redactSecretLikeDiff(kept);
    expect(result.diff).toBe(kept);
    expect(result.redacted).toBe(false);
  });
});

describe("redactLocalPaths", () => {
  it("redactLocalPaths replaces POSIX, drive-letter and UNC paths, keeping non-ASCII and punctuation inside a name", () => {
    expect(redactLocalPaths("failure at /secret")).toBe("failure at <path>");
    expect(redactLocalPaths("failure at C:\\secret")).toBe("failure at <path>");
    expect(redactLocalPaths("failure at \\\\server\\share")).toBe("failure at <path>");
    expect(redactLocalPaths("failure at /tmp/a+b.txt")).toBe("failure at <path>");
    expect(redactLocalPaths("failure at /tmp/project(foo)/x")).toBe("failure at <path>");
    expect(redactLocalPaths("failure at C:\\Program Files (x86)\\secret")).toBe("failure at <path>");
    expect(redactLocalPaths("failure at /tmp/项目/秘密.txt")).toBe("failure at <path>");
    expect(redactLocalPaths("failure at '/home/alice's-folder/secret'")).not.toContain("alice's-folder");
  });
});
