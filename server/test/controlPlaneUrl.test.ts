import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { hostControlPlaneUrl } from "../src/modules/hosts/controlPlaneUrl.js";

describe("hostControlPlaneUrl", () => {
  it("uses the configured public origin and preserves its port for a paired host", () => {
    expect(hostControlPlaneUrl(loadConfig({ PUBLIC_BASE_URL: "https://rainver.example" }), "remote"))
      .toBe("https://rainver.example");
    expect(hostControlPlaneUrl(loadConfig({ PUBLIC_BASE_URL: "https://rainver.example:8443/" }), "remote"))
      .toBe("https://rainver.example:8443");
  });

  it("hands the built-in host its in-network address", () => {
    expect(hostControlPlaneUrl(loadConfig({ PUBLIC_BASE_URL: "https://rainver.example" }), "server"))
      .toBe("http://server:8010");
  });
});
