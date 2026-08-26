import type { LoginRuntimeConfig } from "../loginEngine.js";

export interface CliLoginAdapter extends LoginRuntimeConfig {
  runtime: string;
  target_path: string;
}
