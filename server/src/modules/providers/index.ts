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
  emptyQuota,
  parseClaudeOAuthUsageResponse,
  parseCodexManagedUsageResponse,
  probeClaudeOAuthQuotaWithAccessToken,
  type QuotaResult,
} from "./subscriptionQuota.js";
