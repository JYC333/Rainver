import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { hostControlPlaneUrl } from "../src/modules/hosts/controlPlaneUrl.js";

describe("hostControlPlaneUrl", () => {
  it("hands a paired host FRONTEND_URL, keeping a path prefix", () => {
    expect(hostControlPlaneUrl(loadConfig({ FRONTEND_URL: "https://rainver.example" }), "remote"))
      .toBe("https://rainver.example");
    expect(hostControlPlaneUrl(loadConfig({ FRONTEND_URL: "https://rainver.example/rainver/" }), "remote"))
      .toBe("https://rainver.example/rainver");
  });

  it("hands the built-in host its in-network address", () => {
    expect(hostControlPlaneUrl(loadConfig({ FRONTEND_URL: "https://rainver.example" }), "server"))
      .toBe("http://server:8010");
  });
});
