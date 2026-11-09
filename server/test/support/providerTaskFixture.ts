import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { loadConfig, type ServerConfig } from "../../src/config.js";
import { buildJobHandlerRegistry } from "../../src/modules/jobs/workerRuntime.js";
import { resolveProviderCommandStore } from "../../src/modules/providers/commands/store.js";
import { __setProviderHttpClientForTests } from "../../src/modules/providers/invocation/invocation.js";
import { PROVIDER_TASK_RUN_JOB_TYPE } from "../../src/modules/runs/providerTaskRunHandler.js";
import { openAiChatResponse } from "./piAiHttp.js";

/**
 * Bounded ProviderTask Runs performed the way the worker performs them: a
 * real `provider_task_run` job dispatched through the job handler registry,
 * against a real ModelProvider row whose key pool holds an encrypted key,
 * with only the provider's HTTP reply faked.
 */

/** A config that can encrypt a pool key and reach the test database. */
export function providerTaskTestConfig(connectionUri: string, home: string): ServerConfig {
  return loadConfig({
    ...process.env,
    SERVER_DATABASE_URL: connectionUri,
    RAINVER_HOME: home,
    // Do not inherit package-manager DEBUG namespaces as the server's
    // boolean debug configuration.
    SERVER_DEBUG: "false",
  });
}

/** An enabled OpenAI-shaped provider, granted to the Space as its default. */
export async function seedTestModelProvider(
  pool: Pool,
  input: { space: string; owner: string; provider?: string; config?: ServerConfig; now?: string },
): Promise<string> {
  const provider = input.provider ?? randomUUID();
  const now = input.now ?? new Date().toISOString();
  await pool.query(
    `INSERT INTO model_providers (id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at)
     VALUES ($1,$2,$3,'Test Provider','openai','https://example.invalid/v1','test-model',true,'{}'::jsonb,'{}'::jsonb,$4,$4)`,
    [provider, input.space, input.owner, now],
  );
  await pool.query(
    `INSERT INTO model_provider_space_grants (id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$4,true,true,$5,$5)`,
    [randomUUID(), provider, input.space, input.owner, now],
  );
  if (input.config) {
    await resolveProviderCommandStore(input.config).addPoolCredential(input.space, input.owner, provider, { api_key: "test-provider-task-key" });
  }
  return provider;
}

/** Every provider call answers with this structured object. */
export function replyWithStructuredOutput(output: unknown): void {
  __setProviderHttpClientForTests({
    fetch: async () => openAiChatResponse({
      choices: [{ message: { content: JSON.stringify(output) } }],
      model: "test-model",
      usage: {},
    }),
  });
}

/** Every provider call fails as a server error. */
export function replyWithProviderFailure(): void {
  __setProviderHttpClientForTests({ fetch: async () => new Response("{}", { status: 500 }) });
}

export function resetProviderReplies(): void {
  __setProviderHttpClientForTests(null);
}

/** Dispatches one attempt of the Run's `provider_task_run` job. */
export async function performQueuedProviderTask(
  config: ServerConfig,
  input: { spaceId: string; userId: string; runId: string; attempts?: number; maxAttempts?: number },
): Promise<unknown> {
  const attempts = input.attempts ?? 1;
  return buildJobHandlerRegistry(config).dispatch({
    job_id: randomUUID(),
    space_id: input.spaceId,
    user_id: input.userId,
    job_type: PROVIDER_TASK_RUN_JOB_TYPE,
    attempts,
    max_attempts: input.maxAttempts ?? attempts,
    worker_id: "test-worker",
    payload: { run_id: input.runId },
  });
}
