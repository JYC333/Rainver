import type { Pool } from "./pool";
import { syncBuiltinPrompts } from "../modules/prompts/builtins";

interface Logger {
  info: (msg: string) => void;
}

export async function runBuiltInSeeds(pool: Pool, log: Logger, catalogRoot: string): Promise<void> {
  await seedEvolutionStrategyAssets(pool);
  await seedSourceConnectors(pool);
  const promptSync = await syncBuiltinPrompts(pool, catalogRoot);
  log.info(
    [
      "[seeds] built-in assets upserted",
      `prompt_assets=${promptSync.assetKeys.length}`,
      `prompt_versions_created=${promptSync.versionsCreated.length}`,
    ].join(" "),
  );
}

async function seedEvolutionStrategyAssets(pool: Pool): Promise<void> {
  // Runtime stats (success_count, failure_count, confidence_score, last_selected_at)
  // are preserved on conflict — only static/config fields are updated.
  await pool.query(`
    INSERT INTO evolution_strategy_assets (
      id, space_id, strategy_key, name, description, category, target_type, status,
      risk_level, signals_match_json, preconditions_json, strategy_steps_json,
      constraints_json, validation_policy_json, tool_policy_json, routing_hint_json,
      provenance_type, source_ref_json, success_count, failure_count, confidence_score,
      last_selected_at, created_at, updated_at
    ) VALUES
    (
      '00000000-0000-4000-8000-000000000101', NULL, 'repair.runtime_failure',
      'Repair runtime failure',
      'Inspect failed runtime evidence and propose the smallest reviewable correction path.',
      'repair', 'system', 'active', 'medium',
      '["runtime_failure","adapter_failed","run_failed","tool_error"]',
      '{"requires_recent_signal": true}',
      '["collect_run_trace","identify_failure_layer","draft_minimal_repair_plan","require_validation_before_apply"]',
      '["do_not_mutate_target_directly","use_existing_run_artifact_proposal_boundaries"]',
      '{"requires_run_trace": true, "requires_validation": true}',
      '{"allow_direct_apply": false}',
      '{"preferred_run_mode": "dry_run"}',
      'built_in', '{"source": "agent_space_native_seed"}', 0, 0, 0.55,
      NULL, '2026-06-29 00:00:00+00', '2026-06-29 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-000000000102', NULL, 'repair.validation_failure',
      'Repair validation failure',
      'Use validation evidence to narrow an improvement target and create a reviewable repair plan.',
      'repair', 'system', 'active', 'medium',
      '["validation_failure","run_validation_failed","evaluation_failed","proposal_rejected"]',
      '{"requires_validation_trace": true}',
      '["summarize_validation_failure","compare_expected_vs_observed","draft_repair_plan","record_review_artifact"]',
      '["do_not_weaken_validation_policy","do_not_apply_without_approval"]',
      '{"requires_validation_trace": true, "minimum_evidence_count": 1}',
      '{"allow_direct_apply": false}',
      '{"preferred_run_mode": "dry_run"}',
      'built_in', '{"source": "agent_space_native_seed"}', 0, 0, 0.55,
      NULL, '2026-06-29 00:00:00+00', '2026-06-29 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-000000000103', NULL, 'optimize.prompt_asset',
      'Optimize prompt asset',
      'Improve prompt-like agent or capability assets through review artifacts and proposal-gated changes.',
      'optimize', 'agent_version', 'active', 'medium',
      '["stable_preference_missed","user_repeated_same_correction","prompt_gap","proposal_edited"]',
      '{"requires_target_owner_review": true}',
      '["collect_corrections","summarize_prompt_gap","draft_prompt_revision_artifact","route_to_supported_proposal_type"]',
      '["do_not_create_prompt_update_without_registered_applier","preserve_policy_ceiling"]',
      '{"requires_before_after_review": true}',
      '{"allow_direct_apply": false}',
      '{"preferred_artifact_type": "evolution_plan.v1"}',
      'built_in', '{"source": "agent_space_native_seed"}', 0, 0, 0.5,
      NULL, '2026-06-29 00:00:00+00', '2026-06-29 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-000000000104', NULL, 'optimize.tool_usage',
      'Optimize tool usage',
      'Review tool-use evidence and propose safer or more effective capability/runtime binding changes.',
      'optimize', 'runtime_skill_binding', 'active', 'high',
      '["tool_error","tool_overuse","tool_missing","runtime_skill_binding_gap"]',
      '{"requires_runtime_binding_context": true}',
      '["summarize_tool_trace","identify_binding_gap","draft_runtime_skill_binding_review","require_proposal_gate"]',
      '["do_not_grant_new_tools_directly","do_not_expand_permissions_without_proposal"]',
      '{"requires_policy_review_for_permission_change": true}',
      '{"allow_direct_apply": false, "permission_expansion_requires_high_risk": true}',
      '{"preferred_proposal_type": "runtime_skill_binding_update"}',
      'built_in', '{"source": "agent_space_native_seed"}', 0, 0, 0.5,
      NULL, '2026-06-29 00:00:00+00', '2026-06-29 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-000000000105', NULL, 'harden.policy_boundary',
      'Harden policy boundary',
      'Prioritize fail-closed review when signals indicate a policy, permission, sandbox, or credential boundary risk.',
      'harden', 'system', 'active', 'high',
      '["policy_boundary","policy_denied","permission_boundary","sandbox_boundary","credential_boundary"]',
      '{"requires_boundary_signal": true}',
      '["collect_boundary_evidence","classify_invariant","draft_hardening_plan","require_owner_review"]',
      '["do_not_reduce_policy_risk","do_not_bypass_policy_gateway","do_not_auto_apply"]',
      '{"requires_policy_trace": true, "requires_owner_review": true}',
      '{"allow_direct_apply": false, "force_review": true}',
      '{"preferred_run_status": "waiting_for_review"}',
      'built_in', '{"source": "agent_space_native_seed"}', 0, 0, 0.65,
      NULL, '2026-06-29 00:00:00+00', '2026-06-29 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-000000000106', NULL, 'improve.capability_gap',
      'Improve capability gap',
      'Convert repeated capability-gap signals into a reviewed capability install/update/enable plan.',
      'innovate', 'capability', 'active', 'high',
      '["capability_gap","missing_capability","workflow_gap","user_improvement_request"]',
      '{"requires_reviewable_capability_boundary": true}',
      '["summarize_gap","map_to_existing_capability","draft_capability_change_plan","route_through_capability_proposal"]',
      '["external_skills_default_disabled","do_not_enable_capability_directly"]',
      '{"requires_capability_lifecycle": true}',
      '{"allow_direct_apply": false, "external_source_untrusted": true}',
      '{"preferred_proposal_types": ["capability_install","capability_update","capability_enable"]}',
      'built_in', '{"source": "agent_space_native_seed"}', 0, 0, 0.5,
      NULL, '2026-06-29 00:00:00+00', '2026-06-29 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-000000000107', NULL, 'review.open_skill_import',
      'Review Open Skill import',
      'Treat external skill material as untrusted source and produce proposal-gated review steps.',
      'review', 'capability', 'active', 'high',
      '["open_skill_imported","external_skill_detected","skill_risk_warning","script_files_detected"]',
      '{"requires_skill_package_snapshot": true}',
      '["summarize_import_snapshot","surface_risk_warnings","draft_review_packet","keep_capability_disabled_until_approved"]',
      '["do_not_execute_imported_scripts","do_not_auto_enable_external_skill"]',
      '{"requires_source_snapshot": true, "requires_risk_scan": true}',
      '{"allow_direct_apply": false, "scripts_executable": false}',
      '{"preferred_proposal_types": ["skill_import_approve","capability_install"]}',
      'built_in', '{"source": "agent_space_native_seed"}', 0, 0, 0.6,
      NULL, '2026-06-29 00:00:00+00', '2026-06-29 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-000000000108', NULL, 'maintain.memory_health',
      'Maintain memory health',
      'Use memory quality signals to create review packets or memory proposals without direct memory writes.',
      'maintain', 'memory', 'active', 'medium',
      '["memory_health","duplicate_memory","stale_memory","thin_memory","memory_candidate_rejected"]',
      '{"requires_visible_memory_scope": true}',
      '["collect_memory_findings","group_reviewable_candidates","draft_memory_maintenance_packet","preserve_proposal_gate"]',
      '["do_not_write_active_memory_directly","log_memory_reads_through_memory_boundary"]',
      '{"requires_memory_read_boundary": true}',
      '{"allow_direct_apply": false}',
      '{"preferred_proposal_type": "memory_maintenance_packet"}',
      'built_in', '{"source": "agent_space_native_seed"}', 0, 0, 0.55,
      NULL, '2026-06-29 00:00:00+00', '2026-06-29 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-000000000109', NULL, 'maintain.knowledge_retrieval',
      'Maintain knowledge retrieval',
      'Review retrieval quality signals and produce diagnostics or maintenance proposals through existing boundaries.',
      'maintain', 'knowledge', 'active', 'medium',
      '["retrieval_gap","low_retrieval_quality","missing_relation","knowledge_retrieval"]',
      '{"requires_retrieval_trace": true}',
      '["collect_retrieval_trace","identify_missing_or_noisy_sources","draft_retrieval_maintenance_packet","require_review"]',
      '["do_not_promote_knowledge_to_memory_directly","do_not_trust_derived_index_without_revalidation"]',
      '{"requires_retrieval_evidence": true}',
      '{"allow_direct_apply": false}',
      '{"preferred_proposal_type": "retrieval_maintenance_packet"}',
      'built_in', '{"source": "agent_space_native_seed"}', 0, 0, 0.55,
      NULL, '2026-06-29 00:00:00+00', '2026-06-29 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-000000000110', NULL, 'solidifyExperience.successful_run',
      'Solidify Experience successful run',
      'Turn accepted or validated run outcomes into reusable EvolutionExperience records.',
      'maintain', 'system', 'active', 'low',
      '["run_succeeded","proposal_accepted","validation_passed","experience_candidate"]',
      '{"requires_validated_outcome": true}',
      '["extract_outcome_trace","summarize_lessons","record_evolution_experience","update_strategy_confidence"]',
      '["do_not_mutate_behavior_from_experience","record_experience_only"]',
      '{"requires_success_or_partial_outcome": true}',
      '{"allow_direct_apply": false}',
      '{"service": "ExperienceSolidifier"}',
      'built_in', '{"source": "agent_space_native_seed"}', 0, 0, 0.6,
      NULL, '2026-06-29 00:00:00+00', '2026-06-29 00:00:00+00'
    )
    ON CONFLICT (id) DO UPDATE SET
      strategy_key          = EXCLUDED.strategy_key,
      name                  = EXCLUDED.name,
      description           = EXCLUDED.description,
      category              = EXCLUDED.category,
      target_type           = EXCLUDED.target_type,
      status                = EXCLUDED.status,
      risk_level            = EXCLUDED.risk_level,
      signals_match_json    = EXCLUDED.signals_match_json,
      preconditions_json    = EXCLUDED.preconditions_json,
      strategy_steps_json   = EXCLUDED.strategy_steps_json,
      constraints_json      = EXCLUDED.constraints_json,
      validation_policy_json = EXCLUDED.validation_policy_json,
      tool_policy_json      = EXCLUDED.tool_policy_json,
      routing_hint_json     = EXCLUDED.routing_hint_json,
      provenance_type       = EXCLUDED.provenance_type,
      source_ref_json       = EXCLUDED.source_ref_json,
      updated_at            = now()
  `);
}

async function seedSourceConnectors(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO source_providers (
      id, provider_key, display_name, provider_kind, category, status,
      capabilities_json, config_schema_json, created_at, updated_at
    ) VALUES
      ('00000000-0000-4000-8000-00000000e001', 'arxiv', 'arXiv', 'named', 'academic', 'active',
       '{"search":true,"supports_full_history":true,"date_fields":["submittedDate","lastUpdatedDate"],"dedupe_keys":["arxiv_id","doi"]}',
       '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000e002', 'generic_rss', 'RSS Feed', 'generic', 'feed', 'active',
       '{"search":false,"formats":["rss"]}', '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000e003', 'generic_atom', 'Atom Feed', 'generic', 'feed', 'active',
       '{"search":false,"formats":["atom"]}', '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000e004', 'generic_web_page', 'Web Page', 'generic', 'web', 'active',
       '{"search":false,"formats":["html"]}', '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000e005', 'custom_source', 'Custom Source', 'generic', 'custom', 'active',
       '{"search":false,"formats":["html"]}', '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000e006', 'openalex', 'OpenAlex', 'named', 'academic', 'active',
       '{"search":true,"supports_full_history":true,"date_fields":["publication_date"],"dedupe_keys":["doi","arxiv_id","openalex_id"],"credential_optional":true}',
       '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000e007', 'semantic_scholar', 'Semantic Scholar', 'named', 'academic', 'active',
       '{"search":true,"supports_full_history":false,"date_fields":["publication_date"],"dedupe_keys":["doi","arxiv_id","semantic_scholar_id"],"credential_optional":true}',
       '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000e008', 'web_search', 'Web Search', 'named', 'web', 'active',
       '{"search":true,"supports_full_history":false,"dedupe_keys":["canonical_uri"],"credential_optional":false,"trust_level":"untrusted"}',
       '{"type":"object"}', now(), now())
    ON CONFLICT (provider_key) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      provider_kind = EXCLUDED.provider_kind,
      category = EXCLUDED.category,
      status = EXCLUDED.status,
      capabilities_json = EXCLUDED.capabilities_json,
      config_schema_json = EXCLUDED.config_schema_json,
      updated_at = now()
  `);
  await pool.query(`
    INSERT INTO source_connectors (
      id, connector_key, display_name, connector_type, ingestion_mode, status,
      capabilities_json, config_schema_json, created_at, updated_at
    ) VALUES
    (
      '00000000-0000-4000-8000-00000000f001', 'rss', 'RSS Feed',
      'external_feed', 'pull', 'active',
      '{"formats":["rss"],"supports_cursor":true,"supports_conditional_fetch":true,"item_type":"feed_entry"}',
      '{"type":"object","required":["endpoint_url"],"properties":{"endpoint_url":{"type":"string","format":"uri"}}}',
      '2026-06-30 00:00:00+00', '2026-06-30 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-00000000f002', 'atom', 'Atom Feed',
      'external_feed', 'pull', 'active',
      '{"formats":["atom"],"supports_cursor":true,"supports_conditional_fetch":true,"item_type":"feed_entry"}',
      '{"type":"object","required":["endpoint_url"],"properties":{"endpoint_url":{"type":"string","format":"uri"}}}',
      '2026-06-30 00:00:00+00', '2026-06-30 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-00000000f003', 'web_page', 'Watched Web Page',
      'external_url', 'pull', 'active',
      '{"formats":["html"],"supports_cursor":true,"supports_conditional_fetch":true,"item_type":"external_url"}',
      '{"type":"object","required":["endpoint_url"],"properties":{"endpoint_url":{"type":"string","format":"uri"}}}',
      '2026-06-30 00:00:00+00', '2026-06-30 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-00000000f004', 'custom_source', 'Custom Source',
      'external_url', 'pull', 'active',
      '{"formats":["html"],"supports_cursor":false,"supports_conditional_fetch":false,"item_type":"external_url","handler_kind":"generated_custom"}',
      '{"type":"object","required":["endpoint_url"],"properties":{"endpoint_url":{"type":"string","format":"uri"}}}',
      '2026-07-01 00:00:00+00', '2026-07-01 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-00000000f005', 'arxiv_api', 'arXiv API',
      'external_feed', 'pull', 'active',
      '{"category":"academic","formats":["atom","html","pdf"],"supports_cursor":true,"supports_conditional_fetch":false,"item_type":"feed_entry"}',
      '{"type":"object","required":["mode"],"properties":{"mode":{"type":"string","enum":["search","recent_by_category"]},"search_query":{"type":"string","maxLength":500},"categories":{"type":"array","items":{"type":"string","maxLength":64},"maxItems":10},"max_results":{"type":"integer","minimum":1,"maximum":100},"sort_by":{"type":"string","enum":["relevance","lastUpdatedDate","submittedDate"]},"sort_order":{"type":"string","enum":["ascending","descending"]}}}',
      '2026-07-03 00:00:00+00', '2026-07-03 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-00000000f006', 'openalex_api', 'OpenAlex API',
      'external_feed', 'pull', 'active',
      '{"category":"academic","formats":["json"],"supports_cursor":true,"supports_conditional_fetch":false,"item_type":"feed_entry"}',
      '{"type":"object","required":["search"],"properties":{"search":{"type":"string","maxLength":500},"per_page":{"type":"integer","minimum":1,"maximum":100},"from_publication_date":{"type":"string"},"to_publication_date":{"type":"string"}}}',
      '2026-07-19 00:00:00+00', '2026-07-19 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-00000000f007', 'semantic_scholar_api', 'Semantic Scholar Graph API',
      'external_feed', 'pull', 'active',
      '{"category":"academic","formats":["json"],"supports_cursor":true,"supports_conditional_fetch":false,"item_type":"feed_entry"}',
      '{"type":"object","required":["query"],"properties":{"query":{"type":"string","maxLength":500},"limit":{"type":"integer","minimum":1,"maximum":100},"from_publication_date":{"type":"string"},"to_publication_date":{"type":"string"}}}',
      '2026-07-19 00:00:00+00', '2026-07-19 00:00:00+00'
    ),
    (
      '00000000-0000-4000-8000-00000000f008', 'brave_web_search_api', 'Brave Web Search API',
      'external_feed', 'pull', 'active',
      '{"category":"web","formats":["json"],"supports_cursor":true,"supports_conditional_fetch":false,"item_type":"external_url"}',
      '{"type":"object","required":["q"],"properties":{"q":{"type":"string","maxLength":400},"count":{"type":"integer","minimum":1,"maximum":20},"freshness":{"type":"string"}}}',
      '2026-07-19 00:00:00+00', '2026-07-19 00:00:00+00'
    )
    ON CONFLICT (id) DO UPDATE SET
      connector_key     = EXCLUDED.connector_key,
      display_name      = EXCLUDED.display_name,
      connector_type    = EXCLUDED.connector_type,
      ingestion_mode    = EXCLUDED.ingestion_mode,
      status            = EXCLUDED.status,
      capabilities_json = EXCLUDED.capabilities_json,
      config_schema_json = EXCLUDED.config_schema_json,
      updated_at        = now()
  `);
  await pool.query(`
    INSERT INTO source_provider_connectors (
      id, provider_id, connector_id, status, priority, capabilities_json,
      config_schema_json, created_at, updated_at
    ) VALUES
      ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000f005', 'active', 10, '{"search":true,"supports_full_history":true}', '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-00000000f001', 'active', 10, '{"search":false}', '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000d003', '00000000-0000-4000-8000-00000000e003', '00000000-0000-4000-8000-00000000f002', 'active', 10, '{"search":false}', '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000d004', '00000000-0000-4000-8000-00000000e004', '00000000-0000-4000-8000-00000000f003', 'active', 10, '{"search":false}', '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000d005', '00000000-0000-4000-8000-00000000e005', '00000000-0000-4000-8000-00000000f004', 'active', 10, '{"search":false}', '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000d006', '00000000-0000-4000-8000-00000000e006', '00000000-0000-4000-8000-00000000f006', 'active', 10, '{"search":true,"supports_full_history":true}', '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000d007', '00000000-0000-4000-8000-00000000e007', '00000000-0000-4000-8000-00000000f007', 'active', 10, '{"search":true,"supports_full_history":false}', '{"type":"object"}', now(), now()),
      ('00000000-0000-4000-8000-00000000d008', '00000000-0000-4000-8000-00000000e008', '00000000-0000-4000-8000-00000000f008', 'active', 10, '{"search":true,"supports_full_history":false,"trust_level":"untrusted"}', '{"type":"object"}', now(), now())
    ON CONFLICT (provider_id, connector_id) DO UPDATE SET
      status = EXCLUDED.status,
      priority = EXCLUDED.priority,
      capabilities_json = EXCLUDED.capabilities_json,
      config_schema_json = EXCLUDED.config_schema_json,
      updated_at = now()
  `);
}
