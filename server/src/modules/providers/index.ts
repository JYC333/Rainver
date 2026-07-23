/**
 * Provider module.
 *
 * The server owns provider reads, commands, invocation, credential pools,
 * CLI credential login/brokering/audit, and internal credential-release ports.
 */

import type { ServerModule } from "../../gateway/routeRegistry";
import { registerRoutes } from "./routes";

export const providersModule: ServerModule = {
  name: "providers",
  registerRoutes,
};

export { getProviderConfig, listProviderConfigs } from "./service";
export {
  decryptModelProviderApiKeySecretRefV1,
  encryptModelProviderApiKeySecretRefV1,
  loadOrCreateModelProviderApiKeyMasterKey,
  MODEL_PROVIDER_API_KEY_AUTH_TAG_BYTES,
  MODEL_PROVIDER_API_KEY_MASTER_KEY_BYTES,
  MODEL_PROVIDER_API_KEY_NONCE_BYTES,
  MODEL_PROVIDER_API_KEY_SECRET_REF_V1_PREFIX,
  parseModelProviderApiKeySecretRefV1,
  SecretRefCompatibilityError,
} from "./secretRefCrypto";
export {
  __setProviderCommandStoreForTests,
  orderPoolMembers,
  ProviderCommandNotFoundError,
  ProviderCommandValidationError,
  resolveProviderCommandStore,
  type InvocationTarget,
  type PoolKeyCandidate,
  type PoolOutcome,
  type ProviderCommandStore,
  type ProviderInfo,
  type ProviderTaskChainEntry,
  type RotationStrategy,
} from "./commands/store";
export {
  __setNetworkRetryDelayForTests,
  __setProviderHttpClientForTests,
  buildProviderModelName,
  completeProviderChat,
  completeProviderEmbedding,
  completeProviderRerank,
  completeProviderText,
  ProviderInvocationError,
  type ProviderRerankResult,
  type ProviderHttpClient,
} from "./invocation/invocation";
export { classifyProviderFailure } from "./invocation/resilience";
export {
  __setLoginFactoriesForTests,
  runCliLogin,
  sendCliLoginInput,
  type LoginToolResolver,
  type LoginEvent,
  type LoginRuntimeConfig,
  type PtyFactory,
} from "./cli/loginEngine";
export {
  CLI_LOGIN_ADAPTERS,
  cliLoginAdapterFor,
  type CliLoginAdapter,
} from "./cli/loginAdapters";
export { __setMountinfoReaderForTests, resolveHostPath } from "./cli/hostPath";
export {
  readClaudeUsageImportEvents,
  readClaudeTokenUsage,
  unsupportedTokenUsage,
  type CliUsageImportEvent,
  type CliUsageImportScan,
  type TokenUsage,
} from "./cli/usageReader";
export { readCodexTokenUsage, readCodexUsageImportEvents } from "./cli/codexUsageReader";
export {
  __setProbeFactoryForTests,
  parseQuota,
  probeClaudeQuota,
  type ProbePtyFactory,
  type ProbeToolResolver,
  type QuotaResult,
} from "./cli/usageProbe";
export {
  __setClaudeOAuthUsageHttpClientForTests,
  parseClaudeOAuthUsageResponse,
  probeClaudeOAuthQuota,
  type ClaudeOAuthHttpClient,
} from "./cli/claudeOAuthUsageProbe";
export {
  __setCodexRpcFactoryForTests,
  probeCodexQuota,
  type CodexRpcFactory,
  type CodexRpcHandle,
} from "./cli/codexUsageProbe";
export {
  CLI_USAGE_REFRESH_INTERVAL_MS,
  startCliUsageRefreshScheduler,
  type CliUsageRefreshBroker,
  type CliUsageRefreshScheduler,
} from "./cli/usageScheduler";
