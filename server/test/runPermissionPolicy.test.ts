import { describe, expect, it } from "vitest";
import { decidePermission } from "../src/modules/runs/runPermissionPolicy";

describe("decidePermission", () => {
  it("selects the allow_once option when one is offered", () => {
    expect(decidePermission([
      { option_id: "reject", kind: "reject_once" },
      { option_id: "allow", kind: "allow_once" },
    ])).toEqual({
      outcome: { outcome: "selected", option_id: "allow" },
      preauthorized_by: "dispatch_approval_preset",
    });
  });

  it("falls back to allow_always when no allow_once option is offered", () => {
    expect(decidePermission([
      { option_id: "reject", kind: "reject_once" },
      { option_id: "allow", kind: "allow_always" },
    ])).toEqual({
      outcome: { outcome: "selected", option_id: "allow" },
      preauthorized_by: "dispatch_approval_preset",
    });
  });

  it("prefers allow_once over allow_always when both are offered", () => {
    expect(decidePermission([
      { option_id: "allow-always", kind: "allow_always" },
      { option_id: "allow-once", kind: "allow_once" },
    ])).toEqual({
      outcome: { outcome: "selected", option_id: "allow-once" },
      preauthorized_by: "dispatch_approval_preset",
    });
  });

  it("cancels when no allow option is offered at all", () => {
    expect(decidePermission([
      { option_id: "reject", kind: "reject_once" },
    ])).toEqual({
      outcome: { outcome: "cancelled" },
      preauthorized_by: "dispatch_approval_preset",
    });
  });

  it("treats an allow-kind option with no option_id as absent", () => {
    expect(decidePermission([
      { option_id: null, kind: "allow_once" },
    ])).toEqual({
      outcome: { outcome: "cancelled" },
      preauthorized_by: "dispatch_approval_preset",
    });
  });

  it("cancels on an empty option list", () => {
    expect(decidePermission([])).toEqual({
      outcome: { outcome: "cancelled" },
      preauthorized_by: "dispatch_approval_preset",
    });
  });
});
