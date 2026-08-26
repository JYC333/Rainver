/**
 * Provider module.
 *
 * The server owns provider reads, commands, invocation, credential pools,
 * CLI credential login/brokering/audit, and internal credential-release ports.
 */

import type { ServerModule } from "../../gateway/routeRegistry.js";
import { registerRoutes } from "./routes.js";

export const providersModule: ServerModule = {
  name: "providers",
  registerRoutes,
};

export { getProviderConfig, listProviderConfigs } from "./service.js";
export {
  decryptModelProviderApiKeySecretRefV1,
  encryptModelProviderApiKeySecretRefV1,
  loadOrCreateModelProviderApiKeyMasterKey,
  MODEL_PROVIDER_API_KEY_AUTH_TAG_BYTES,
  MODEL_PROVIDER_API_KEY_MASTER_KEY_BYTES,
  MODEL_PROVIDER_API_KEY_NONCE_BYTES,
  MODEL_PROVIDER_API_KEY_SECRET_REF_V1_PREFIX,
  MODEL_PROVIDER_OAUTH_SECRET_REF_V1_PREFIX,
  decryptModelProviderOAuthSecretRefV1,
  encryptModelProviderOAuthSecretRefV1,
  parseModelProviderApiKeySecretRefV1,
  SecretRefCompatibilityError,
} from "./secretRefCrypto.js";
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
} from "./commands/store.js";
export {
  __setNetworkRetryDelayForTests,
  __setProviderHttpClientForTests,
  completeProviderChat,
  completeProviderEmbedding,
  completeProviderRerank,
  completeProviderText,
  ProviderInvocationError,
  type ProviderRerankResult,
  type ProviderHttpClient,
} from "./invocation/invocation.js";
export { classifyProviderFailure } from "./invocation/resilience.js";
export {
  __setLoginFactoriesForTests,
  runCliLogin,
  sendCliLoginInput,
  type LoginToolResolver,
  type LoginEvent,
  type LoginRuntimeConfig,
  type PtyFactory,
} from "./cli/loginEngine.js";
export {
  CLI_LOGIN_ADAPTERS,
  cliLoginAdapterFor,
  type CliLoginAdapter,
} from "./cli/loginAdapters/index.js";
export { __setMountinfoReaderForTests, resolveHostPath } from "./cli/hostPath.js";
export {
  readClaudeUsageImportEvents,
  readClaudeTokenUsage,
  unsupportedTokenUsage,
  type CliUsageImportEvent,
  type CliUsageImportScan,
  type TokenUsage,
} from "./cli/usageReader.js";
export { readCodexTokenUsage, readCodexUsageImportEvents } from "./cli/codexUsageReader.js";
export {
  __setProbeFactoryForTests,
  parseQuota,
  probeClaudeQuota,
  type CodexProbeToolResolver,
  type ProbePtyFactory,
  type ProbeToolResolver,
  type QuotaResult,
} from "./cli/usageProbe.js";
export {
  __setClaudeOAuthUsageHttpClientForTests,
  parseClaudeOAuthUsageResponse,
  probeClaudeOAuthQuota,
  probeClaudeOAuthQuotaWithAccessToken,
  type ClaudeOAuthHttpClient,
} from "./cli/claudeOAuthUsageProbe.js";
export {
  __setCodexRpcFactoryForTests,
  parseCodexManagedUsageResponse,
  probeCodexQuota,
  type CodexRpcFactory,
  type CodexRpcHandle,
} from "./cli/codexUsageProbe.js";
export {
  CLI_USAGE_REFRESH_INTERVAL_SECONDS,
  createCliUsageRefreshTask,
  type CliUsageRefreshBroker,
  type CliUsageRefreshTask,
} from "./cli/usageScheduler.js";
