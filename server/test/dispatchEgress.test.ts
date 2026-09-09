import { describe, expect, it } from "vitest";
import { dispatchInstallation, dispatchIsolation } from "../src/modules/runs/remoteHostCliAdapter.js";

/**
 * What a dispatched Run may reach. `default` is the ordinary answer — the
 * general web, git and the vendor a subscription belongs to, with package
 * registries refused. `install` widens it and comes only from the dispatch,
 * which the server composes: a standing grant on the Agent runtime profile
 * would sit behind a read predicate, so it is deliberately not read.
 */
describe("the egress policy a dispatch states", () => {
  it("gives an ordinary Run default, not the reach of an install", () => {
    expect(dispatchIsolation({ required_sandbox_level: "workspace_write" }))
      .toEqual({ sandbox_mode: "read_write", egress_profile: "default" });
  });

  it("takes the grant only from the dispatch, which the server composes", () => {
    expect(dispatchIsolation({ model_override_json: { egress_profile: "install" } }).egress_profile)
      .toBe("install");
    expect(dispatchIsolation({ model_override_json: { egress_profile: "none" } }).egress_profile)
      .toBe("none");
  });

  it("reads no standing grant off the Agent's runtime config", () => {
    // Writing a runtime profile takes only read access to an ordinary Agent,
    // and `runtime_config_json` is free-form — so a privilege honoured from
    // there is one any member who can see the Agent could grant themselves.
    expect(dispatchIsolation({
      // @ts-expect-error — deliberately passing what an older shape carried.
      runtime_profile_snapshot_json: { runtime_config_json: { egress_install: true } },
    }).egress_profile).toBe("default");
  });

  it("ignores a per-Run value that is not a profile", () => {
    expect(dispatchIsolation({ model_override_json: { egress_profile: "everything" } }).egress_profile)
      .toBe("default");
  });

  it("still states the workspace mode independently of egress", () => {
    expect(dispatchIsolation({
      required_sandbox_level: "read_only",
      model_override_json: { egress_profile: "install" },
    })).toEqual({ sandbox_mode: "read_only", egress_profile: "install" });
  });
});

/**
 * Which copy on the host a dispatch actually launches.
 *
 * Reading only the dispatch override meant a Room turn and a direct chat
 * launched `own` — the machine's own PATH binary. On a paired machine that is
 * the owner's logged-in CLI, so it looked fine while quietly substituting a
 * copy nobody chose; on the built-in host, which has no vendor CLI on PATH,
 * the launch simply fails.
 */
describe("which installation a dispatch names", () => {
  it("takes the runtime profile's copy when the dispatch pins none", () => {
    expect(dispatchInstallation({
      runtime_profile_snapshot_json: { runtime_installation: "managed:2.0.0" },
    })).toBe("managed:2.0.0");
  });

  it("lets a thread's pinned copy win over the profile's", () => {
    expect(dispatchInstallation({
      model_override_json: { installation: "managed:1.0.0" },
      runtime_profile_snapshot_json: { runtime_installation: "managed:2.0.0" },
    })).toBe("managed:1.0.0");
  });

  it("falls back to the machine's own copy only when neither says", () => {
    expect(dispatchInstallation({})).toBe("own");
    expect(dispatchInstallation({ runtime_profile_snapshot_json: { runtime_installation: "  " } })).toBe("own");
  });
});
