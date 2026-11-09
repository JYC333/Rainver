const runtimeLabelSql = `CASE e.runtime_key
  WHEN 'codex_cli' THEN 'Codex'
  WHEN 'claude_code' THEN 'Claude Code'
  WHEN 'opencode' THEN 'OpenCode'
  WHEN 'acp_antigravity_acp' THEN 'Antigravity'
  ELSE e.runtime_key END`;

const nativeCliSql = "e.execution_channel IN ('local_cli', 'local_cli_transcript') AND NULLIF(e.runtime_key, '') IS NOT NULL";

/** Read-model selectors identify usage sources, never create ModelProviders. */
export const usageProviderSourceSql = {
  keySql: `COALESCE(NULLIF(e.provider_id, ''), NULLIF(e.provider_type, ''),
    CASE WHEN NULLIF(e.provider_name_snapshot, '') IS NOT NULL THEN 'name:' || e.provider_name_snapshot END,
    CASE WHEN ${nativeCliSql} THEN 'cli:' || e.runtime_key END,
    CASE WHEN NULLIF(e.vendor, '') IS NOT NULL THEN 'vendor:' || e.vendor END, 'unknown')`,
  labelSql: `COALESCE(NULLIF(e.provider_name_snapshot, ''), NULLIF(e.provider_type, ''), NULLIF(e.provider_id, ''),
    CASE WHEN ${nativeCliSql} THEN (${runtimeLabelSql}) || ' · CLI native' END,
    NULLIF(e.vendor, ''), 'Unknown provider')`,
};

export const usageProviderEventLabelSql = `(${usageProviderSourceSql.labelSql}) ||
  CASE WHEN e.execution_channel = 'provider_proxy' AND NULLIF(e.runtime_key, '') IS NOT NULL
    THEN ' · via ' || (${runtimeLabelSql}) ELSE '' END`;
