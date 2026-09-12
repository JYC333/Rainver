import { describe, expect, it } from "vitest";
import { applyCodexStrictSandboxToml, CODEX_STRICT_SANDBOX_TOML } from "../src/codexStrictSandbox.js";

describe("applyCodexStrictSandboxToml", () => {
  it("inserts workspace-write when the file has no sandbox_mode", () => {
    expect(applyCodexStrictSandboxToml('model = "gpt-5"\n')).toBe(`${CODEX_STRICT_SANDBOX_TOML}\nmodel = "gpt-5"\n`);
  });

  it("replaces a stacked read-only default", () => {
    expect(applyCodexStrictSandboxToml('sandbox_mode = "read-only"\nmodel = "gpt-5"\n'))
      .toBe(`${CODEX_STRICT_SANDBOX_TOML}\nmodel = "gpt-5"\n`);
  });

  /**
   * TOML scopes a key to the table above it. Matching `sandbox_mode` anywhere
   * rewrote a named profile's key and left the top-level default alone, so the
   * Run still could not write — and somebody's profile quietly changed.
   */
  it("sets the top-level key, not a profile's", () => {
    const config = [
      'model = "gpt-5"',
      "",
      "[profiles.readonly]",
      'sandbox_mode = "read-only"',
      "",
    ].join("\n");
    const out = applyCodexStrictSandboxToml(config);
    expect(out).toContain(`${CODEX_STRICT_SANDBOX_TOML}\nmodel = "gpt-5"`);
    // The profile is left exactly as the person wrote it.
    expect(out).toContain('[profiles.readonly]\nsandbox_mode = "read-only"');
  });

  it("replaces the top-level key when one is already there, profiles untouched", () => {
    const config = [
      'sandbox_mode = "read-only"',
      "",
      "[profiles.readonly]",
      'sandbox_mode = "read-only"',
      "",
    ].join("\n");
    const out = applyCodexStrictSandboxToml(config);
    expect(out.split("\n")[0]).toBe(CODEX_STRICT_SANDBOX_TOML);
    expect(out).toContain('[profiles.readonly]\nsandbox_mode = "read-only"');
  });

  /**
   * A continuation line of a multi-line array starts with `[` and is not a
   * table header. Treating it as one made the insert land above a key that was
   * still top-level, leaving two top-level `sandbox_mode` keys — a TOML
   * duplicate-key error, so Codex refuses to start and every strict Run fails.
   */
  it("does not mistake a multi-line array's continuation for a table header", () => {
    // Both spellings: with a trailing comma, and as the final element, which
    // carries none and so reads exactly like a bracketed name alone on a line.
    for (const element of ['  ["a"],', '  ["a"]']) {
      const config = ["notify = [", element, "]", 'sandbox_mode = "read-only"', ""].join("\n");
      const out = applyCodexStrictSandboxToml(config);
      expect(out.split("sandbox_mode").length - 1, element).toBe(1);
      expect(out, element).toContain(CODEX_STRICT_SANDBOX_TOML);
    }
  });

  it("does not mistake a bracket inside a string or a comment for an array", () => {
    // One unbalanced `[` above the first header used to pin the bracket depth
    // for the rest of the file, so no header was ever found and the scan fell
    // back to matching `sandbox_mode` anywhere — the original bug, reinstated
    // by the fix for the array one.
    for (const first of ['notify = ["bash","-c","echo [done"]', "# see the [profiles docs", 'foo = "a\\"b[c"']) {
      const config = [first, "[profiles.x]", 'sandbox_mode = "read-only"', ""].join("\n");
      const out = applyCodexStrictSandboxToml(config);
      expect(out, first).toContain(`${CODEX_STRICT_SANDBOX_TOML}\n${first}`);
      expect(out, first).toContain('[profiles.x]\nsandbox_mode = "read-only"');
    }
  });

  it("does not read a line inside a multi-line string as a table header", () => {
    // Nothing inside `"""` or `'''` is syntax. A line reading `[x]` in one was
    // taken as the first table header, which hid the real top-level key and
    // inserted a second — the TOML duplicate-key error that stops Codex from
    // starting. The pre-Phase-8 code got this right by accident.
    for (const quote of ['"""', "'''"]) {
      const config = [
        `instructions = ${quote}`,
        "[not a header]",
        quote,
        'sandbox_mode = "read-only"',
        "[profiles.x]",
        'sandbox_mode = "read-only"',
        "",
      ].join("\n");
      const out = applyCodexStrictSandboxToml(config);
      // Rewritten in place, so still exactly one top-level key.
      expect(out.split("sandbox_mode").length - 1, quote).toBe(2);
      expect(out, quote).toContain(`${quote}\n${CODEX_STRICT_SANDBOX_TOML}`);
      expect(out, quote).toContain('[profiles.x]\nsandbox_mode = "read-only"');
    }
  });

  it("does not rewrite a sandbox_mode line that is inside a multi-line string", () => {
    // The decoy is text, not a key. Rewriting it left the real top-level key
    // untouched, so Codex started cleanly and the Run silently could not write
    // — the failure with no error anywhere.
    for (const quote of ['"""', "'''"]) {
      const config = [
        `notes = ${quote}`,
        'sandbox_mode = "decoy"',
        quote,
        'sandbox_mode = "read-only"',
        "[profiles.x]",
        'sandbox_mode = "read-only"',
        "",
      ].join("\n");
      const out = applyCodexStrictSandboxToml(config);
      expect(out, quote).toContain('sandbox_mode = "decoy"');
      expect(out, quote).toContain(`${quote}\n${CODEX_STRICT_SANDBOX_TOML}`);
      expect(out, quote).toContain('[profiles.x]\nsandbox_mode = "read-only"');
    }
  });

  it("is a no-op when the switch is already set", () => {
    const contents = `${CODEX_STRICT_SANDBOX_TOML}\nmodel = "gpt-5"\n`;
    expect(applyCodexStrictSandboxToml(contents)).toBe(contents);
  });
});
