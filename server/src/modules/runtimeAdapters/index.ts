export {
  BUILTIN_RUNTIME_ADAPTER_SPECS,
  getLocalCliRuntimeAdapterSpec,
  getRuntimeAdapterSpec,
  isImplementedRuntimeAdapter,
  isLocalCliRuntimeAdapter,
  isVendorCliAdapter,
  listRuntimeAdapterSpecs,
  type LocalCliRuntimeAdapterSpec,
  type RuntimeAdapterSpec,
  type RuntimeAdapterType,
  type RuntimeExecutorFamily,
} from "./specs.js";
export {
  assertRuntimeSubagentsDisabled,
  ensureRuntimeSubagentsDisabled,
  RuntimeSubagentConfigError,
} from "./subagentConfig.js";
