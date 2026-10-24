-- rainver:maintenance
-- rainver:maintenance
-- Retire capability metadata; preserve imported Skill content and historical Run tags.
-- current_version_id remains a historical id from the dropped table, without a foreign key.
ALTER TABLE "evolution_targets" DROP CONSTRAINT "evolution_targets_current_version_fkey";--> statement-breakpoint
-- Retired operations can no longer apply. Supersede pending requests without
-- fabricating a human reviewer or changing accepted/rejected history.
UPDATE "proposals"
SET status = 'superseded',
    payload_json = payload_json || jsonb_build_object(
      'superseded_reason', 'Capability layer removed; review and bind the original package in the Skill library instead.',
      'superseded_by_migration', '0004_remove_capability_layer'),
    updated_at = now()
WHERE status = 'pending'
  AND proposal_type IN ('capability_install', 'capability_update', 'capability_enable', 'capability_disable');--> statement-breakpoint
ALTER TABLE "capability_enablements" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "capability_runtime_bindings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "capability_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "capability_enablements" CASCADE;--> statement-breakpoint
DROP TABLE "capability_runtime_bindings" CASCADE;--> statement-breakpoint
DROP TABLE "capability_versions" CASCADE;--> statement-breakpoint
ALTER TABLE "skill_packages" DROP CONSTRAINT "ck_skill_packages_status";--> statement-breakpoint
-- Irreversible: after this update, previously converted and reviewed rows cannot be distinguished.
UPDATE "skill_packages" SET status = 'reviewed' WHERE status = 'converted';--> statement-breakpoint
ALTER TABLE "skill_packages" ADD CONSTRAINT "ck_skill_packages_status" CHECK ((status)::text = ANY (ARRAY[('imported'::character varying)::text, ('reviewed'::character varying)::text, ('rejected'::character varying)::text, ('archived'::character varying)::text, ('superseded'::character varying)::text]));


RESET search_path;

ALTER TABLE "evolution_strategy_assets" DROP CONSTRAINT "ck_evolution_strategy_assets_target_type";--> statement-breakpoint
ALTER TABLE "evolvable_assets" DROP CONSTRAINT "ck_evolvable_assets_asset_type";--> statement-breakpoint
-- Preserve obsolete rows and their references as archived history; never
-- reinterpret a capability target as a Skill (or another active target).
-- Targets had no type constraint: archive every unsupported type, including
-- custom strings accepted by the old API, before enforcing the new constraint.
UPDATE evolution_targets
SET status='archived', enabled=false,
    metadata_json=metadata_json || '{"archive_reason":"Unsupported Evolution target type; archived before enforcing supported types. No Skill mapping.","archived_by_migration":"0005_retire_evolution_targets_and_rename_skills"}'::jsonb,
    updated_at=now()
WHERE target_type NOT IN ('agent_version','memory','knowledge','workflow','project_folder','system');--> statement-breakpoint
UPDATE evolution_strategy_assets
SET status='archived',
    source_ref_json=source_ref_json || '{"archive_reason":"Retired Evolution target type; no Skill mapping.","archived_by_migration":"0005_retire_evolution_targets_and_rename_skills"}'::jsonb,
    updated_at=now()
WHERE target_type IN ('capability','runtime_skill_binding');--> statement-breakpoint
UPDATE evolvable_asset_pins
SET status='archived', updated_at=now()
WHERE asset_id IN (SELECT id FROM evolvable_assets WHERE asset_type='runtime_skill_binding')
  AND status='active';--> statement-breakpoint
UPDATE evolvable_asset_versions
SET status='archived', updated_at=now()
WHERE asset_id IN (SELECT id FROM evolvable_assets WHERE asset_type='runtime_skill_binding')
  AND status <> 'archived';--> statement-breakpoint
UPDATE evolvable_assets
SET status='archived',
    metadata_json=metadata_json || '{"archive_reason":"Retired runtime Skill binding asset type.","archived_by_migration":"0005_retire_evolution_targets_and_rename_skills"}'::jsonb,
    updated_at=now()
WHERE asset_type='runtime_skill_binding';--> statement-breakpoint
-- Accept results normally live on the wire; upgrade historical payloads that
-- explicitly retained this result discriminator without rewriting other text.
UPDATE proposals
SET payload_json=jsonb_set(payload_json,'{result_type}','"skill_overlay"'::jsonb), updated_at=now()
WHERE payload_json->>'result_type'='capability_overlay';--> statement-breakpoint
ALTER TABLE "evolution_strategy_assets" ADD CONSTRAINT "ck_evolution_strategy_assets_target_type" CHECK (status = 'archived' OR (target_type)::text = ANY (ARRAY[('agent_version'::character varying)::text, ('memory'::character varying)::text, ('knowledge'::character varying)::text, ('workflow'::character varying)::text, ('project_folder'::character varying)::text, ('system'::character varying)::text]));--> statement-breakpoint
ALTER TABLE "evolution_targets" ADD CONSTRAINT "ck_evolution_targets_target_type" CHECK (status = 'archived' OR target_type IN ('agent_version', 'memory', 'knowledge', 'workflow', 'project_folder', 'system'));--> statement-breakpoint
ALTER TABLE "evolvable_assets" ADD CONSTRAINT "ck_evolvable_assets_asset_type" CHECK (status = 'archived' OR (asset_type)::text = ANY (ARRAY[('prompt_template'::character varying)::text, ('workflow_template'::character varying)::text, ('agent_config'::character varying)::text, ('source_post_processing_rule'::character varying)::text]));


RESET search_path;
