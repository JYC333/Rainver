import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startJobsWorker } from "../src/modules/jobs/workerRuntime.js";

describe("startJobsWorker", () => {
  it("does not start without a configured database", () => {
    const config = loadConfig({});
    expect(startJobsWorker(config)).toBeNull();
  });
});
