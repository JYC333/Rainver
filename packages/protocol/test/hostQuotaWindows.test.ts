import { expect, it } from "vitest";
import { HostRuntimeUsageSchema } from "../src/hosts.js";
import { HostDaemonFrameSchema } from "../src/hostWire.js";

it("preserves named quota windows through both host wire and public response", () => {
  const quota = { available: true, session_pct: null, session_resets: null, week_pct: null, week_resets: null, error: null,
    windows: [{ id: "seven_day_fable", label: "Fable weekly", used_pct: 90, resets: null }],
  };
  const wire = HostDaemonFrameSchema.parse({ type: "usage_probe_result", request_id: "request-1", quota });
  expect(wire).toMatchObject({ quota: { windows: quota.windows } });
  const response = HostRuntimeUsageSchema.parse({ host_id: "host-1", runtime_key: "claude_code", installation: "own",
    checked_at: "2026-10-26T12:00:00Z", quota,
  });
  expect(response.quota.windows).toEqual(quota.windows);
});
