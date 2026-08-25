import { describe, expect, it } from "vitest";
import { parseProviderBinding } from "../src/commands/run.js";

// The daemon rebuilds the launch frame field by field from the parsed WS
// message, so a field the server sends and this mapping forgets is invisible
// everywhere else: the run still executes, just on this machine's own login
// while the control plane believes it chose a backend. That is exactly how
// `provider_binding` shipped inert once, and it is what this file guards.

describe("provider_binding on the launch frame", () => {
  it("carries the whole binding across the wire", () => {
    const parsed = parseProviderBinding({
      profile_key: "claude_code/provider-1",
      env: { ANTHROPIC_BASE_URL: "http://control-plane:8021/anthropic/l1", ANTHROPIC_AUTH_TOKEN: "t" },
      profile_env: { HOME: ".", CLAUDE_CONFIG_DIR: ".claude" },
      files: [{ relative_path: ".codex/config.toml", contents: "model = \"m\"" }],
    });

    expect(parsed).toEqual({
      profile_key: "claude_code/provider-1",
      env: { ANTHROPIC_BASE_URL: "http://control-plane:8021/anthropic/l1", ANTHROPIC_AUTH_TOKEN: "t" },
      profile_env: { HOME: ".", CLAUDE_CONFIG_DIR: ".claude" },
      files: [{ relative_path: ".codex/config.toml", contents: "model = \"m\"" }],
    });
  });

  it("treats an absent binding as an unbound run, which is the default", () => {
    expect(parseProviderBinding(undefined)).toBeUndefined();
    expect(parseProviderBinding(null)).toBeUndefined();
  });

  it("fails the run rather than degrading a malformed binding into an unbound one", () => {
    for (const malformed of [
      "not an object",
      [],
      { env: {}, profile_env: {} },                                   // no files
      { env: {}, files: [] },                                          // no profile_env
      { profile_env: {}, files: [] },                                  // no env
      { env: { k: 1 }, profile_env: {}, files: [] },                   // non-string env value
      { env: {}, profile_env: { HOME: 2 }, files: [] },                // non-string path
      { profile_key: "a/b", env: {}, profile_env: {}, files: [{ relative_path: ".x" }] },  // file without contents
      { env: {}, profile_env: {}, files: [{ contents: "x" }] },        // file without a path
      // Without a profile key the daemon has nowhere to put the runtime's
      // conversation state, and guessing one would silently strand it.
      { env: {}, profile_env: {}, files: [] },                         // no profile key
      { profile_key: "", env: {}, profile_env: {}, files: [] },        // empty profile key
    ]) {
      expect(() => parseProviderBinding(malformed), JSON.stringify(malformed)).toThrow();
    }
  });
});
