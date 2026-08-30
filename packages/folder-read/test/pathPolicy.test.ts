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
