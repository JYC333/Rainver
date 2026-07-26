import { describe, expect, it } from "vitest";
import {
  CliCredentialGrantRequestSchema,
  CliCredentialGrantResponseSchema,
  ProviderCompletionInternalRequestSchema,
  ProviderCompletionInternalResponseSchema,
  ProviderCredentialsAuthoritySchema,
  ProviderPoolCredentialAddRequestSchema,
  ProviderPoolMemberDTOSchema,
  ProviderPoolResponseSchema,
  ProviderResilienceDecisionSchema,
  ProviderRotationStrategySchema,
  ProviderTaskPolicyDTOSchema,
  ProviderTaskPolicyPutRequestSchema,
  RuntimeCredentialResolveRequestSchema,
  RuntimeCredentialResolveResponseSchema,
} from "../src/index";

describe("provider and credential runtime contracts", () => {
  it("pins the provider completion internal port shape", () => {
    const parsed = ProviderCompletionInternalRequestSchema.parse({
      space_id: "space-1",
      provider_id: "provider-1",
      system: "You are concise",
      user: "hello",
      subject_user_id: "user-1",
    });
    expect(parsed).toMatchObject({
      space_id: "space-1",
      provider_id: "provider-1",
    });
    expect("max_tokens" in parsed).toBe(false);
    expect(
      ProviderCompletionInternalResponseSchema.parse({
        text: "hello",
        model: "gpt-4o-mini",
        usage: { total_tokens: 3 },
      }),
    ).toMatchObject({ text: "hello" });
  });

  it("allows secret material only on internal credential-resolution responses", () => {
    expect(
      RuntimeCredentialResolveRequestSchema.parse({
        kind: "model_provider_api_key",
        space_id: "space-1",
        provider_id: "provider-1",
      }),
    ).toBeDefined();
    expect(
      RuntimeCredentialResolveResponseSchema.parse({
        kind: "model_provider_api_key",
        provider_id: "provider-1",
        api_key: "sk-internal-only",
      }),
    ).toMatchObject({ api_key: "sk-internal-only" });
    expect(
      RuntimeCredentialResolveResponseSchema.parse({
        kind: "credential_api_key",
        credential_id: "credential-1",
        api_key: "sk-credential-internal-only",
      }),
    ).toMatchObject({ credential_id: "credential-1" });
  });

  it("pins CLI grant and provider resilience decision vocabulary", () => {
    expect(
      CliCredentialGrantRequestSchema.parse({
        run_id: "run-1",
        space_id: "space-1",
        user_id: "user-1",
        runtime: "codex_cli",
        risk_level: "medium",
        executor_mode: "worktree",
      }),
    ).toBeDefined();
    expect(
      CliCredentialGrantResponseSchema.parse({
        granted: false,
        profile_id: null,
        runtime: "codex_cli",
        executor_mode: "worktree",
        readonly: false,
        temp_home: null,
        host_source_path: null,
        target_path: null,
        env: {},
        fallback_reason: "no_profile_configured",
      }),
    ).toMatchObject({ granted: false });
    expect(
      ProviderResilienceDecisionSchema.parse({
        failure_class: "rate_limit",
        actions: ["retry_same_key_once", "rotate_key"],
      }),
    ).toBeDefined();
    expect(ProviderCredentialsAuthoritySchema.parse("server")).toBe("server");
    expect(() => ProviderCredentialsAuthoritySchema.parse("python")).toThrow();
  });

  it("accepts the auxiliary-task name on the completion port", () => {
    const parsed = ProviderCompletionInternalRequestSchema.parse({
      space_id: "space-1",
      provider_id: "provider-1",
      system: "",
      user: "hello",
      task: "reflector",
      source_resource_type: "run",
      source_resource_id: "run-1",
    });
    expect(parsed.task).toBe("reflector");
    expect(() => ProviderCompletionInternalRequestSchema.parse({
      space_id: "space-1",
      provider_id: "provider-1",
      system: "",
      user: "hello",
    })).toThrow();
  });

  it("requires an explicit subject for ownerless Space system completions", () => {
    expect(ProviderCompletionInternalRequestSchema.parse({
      space_id: "space-1",
      provider_id: "provider-1",
      system: "",
      user: "refresh indexes",
      space_system_task: true,
      meter_subject_type: "space_system",
      meter_subject_id: "retrieval_embedding_backfill",
    })).toMatchObject({ meter_subject_type: "space_system" });
    expect(() => ProviderCompletionInternalRequestSchema.parse({
      space_id: "space-1",
      provider_id: "provider-1",
      system: "",
      user: "refresh indexes",
      space_system_task: true,
    })).toThrow();
  });

  it("keeps the credential pool surface secret-free", () => {
    const member = {
      id: "member-1",
      credential_id: "credential-1",
      name: "Main pool key",
      position: 0,
      enabled: true,
      healthy: true,
      cooldown_until: null,
      last_failure_class: null,
      request_count: 4,
      failure_count: 1,
      last_used_at: "2026-06-11T12:00:00.000Z",
      created_at: "2026-06-11T11:00:00.000Z",
      updated_at: "2026-06-11T12:00:00.000Z",
    };
    expect(ProviderPoolMemberDTOSchema.parse(member)).toMatchObject({ position: 0 });
    expect(() =>
      ProviderPoolMemberDTOSchema.parse({ ...member, api_key: "sk-leak" }),
    ).toThrow();
    expect(() =>
      ProviderPoolMemberDTOSchema.parse({ ...member, secret_ref: "model_provider_api_key:v1:x:y" }),
    ).toThrow();
    expect(
      ProviderPoolResponseSchema.parse({
        provider_id: "provider-1",
        rotation_strategy: "round_robin",
        fallback_provider_ids: ["provider-2"],
        members: [member],
      }),
    ).toMatchObject({ rotation_strategy: "round_robin" });
    expect(
      ProviderPoolCredentialAddRequestSchema.parse({ api_key: "sk-request-only" }),
    ).toMatchObject({ api_key: "sk-request-only" });
    for (const strategy of ["fill_first", "round_robin", "least_used", "random"]) {
      expect(ProviderRotationStrategySchema.parse(strategy)).toBe(strategy);
    }
  });

  it("pins the per-task provider chain shapes", () => {
    expect(
      ProviderTaskPolicyPutRequestSchema.parse({
        chain: [{ provider_id: "provider-1", model: "gpt-4o-mini" }],
      }),
    ).toMatchObject({ chain: [{ provider_id: "provider-1", model: "gpt-4o-mini" }] });
    expect(() => ProviderTaskPolicyPutRequestSchema.parse({ chain: [] })).toThrow();
    expect(
      ProviderTaskPolicyDTOSchema.parse({
        task: "reflector",
        chain: [{ provider_id: "provider-1", model: null }],
        enabled: true,
        updated_at: "2026-06-11T12:00:00.000Z",
      }),
    ).toMatchObject({ task: "reflector" });
  });
});
