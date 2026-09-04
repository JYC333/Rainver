#!/usr/bin/env node
import { runService } from "./commands/run.js";

runService().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
