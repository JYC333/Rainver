import { z } from 'zod';
const id = z.string().trim().min(1).max(36);
const target = { project_id: id, folder_id: id };
const receipt = z.object({ id, project_id: id, space_id: id, folder_id: id }).strict();
const draftReceipt = receipt.extend({workspace_location_id:id,version:z.number().int().positive()}).strict();
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const relativePath=z.string().trim().min(1).refine(value=>!value.includes('\0')&&!value.includes('\\')&&!value.startsWith('/')&&!/^[a-zA-Z]:/.test(value)&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'),'A relative file path without traversal is required');
const configFields = {
  repo_type: z.string().trim().max(64).transform(value=>value||null).nullable(), tech_stack_json: z.union([z.array(z.string()),z.record(z.unknown())]),
  important_paths_json: z.array(z.string()), forbidden_paths_json: z.array(z.string()),
  test_commands_json: z.array(z.string()), build_commands_json: z.array(z.string()),
  architecture_boundaries_json: z.record(z.unknown()), validation_recipe_id: id.nullable(),
};
export const PROJECT_FOLDER_SCHEMAS = {
  'project.folder.draft.upsert': {input:z.object({...target,workspace_location_id:id.nullable().default(null),expected_version:z.number().int().positive().nullable().default(null),target_kind:z.enum(['existing','new']),relative_path:relativePath,base_exists:z.boolean(),base_sha256:hash.nullable(),content:z.string(),content_sha256:hash,byte_size:z.number().int().min(0).max(1048576),source_encoding:z.enum(['utf8','utf16le','utf16be']),preserve_bom:z.boolean(),line_ending_mode:z.enum(['lf','crlf','mixed','none'])}).strict().refine(input=>(input.base_exists?input.base_sha256!==null:input.base_sha256===null)&&(input.target_kind!=='new'||!input.base_exists),'The draft baseline must match its target'),output:draftReceipt},
  'project.folder.draft.discard': {input:z.object({...target,draft_id:id,draft_version:z.number().int().positive()}).strict(),output:receipt},
  'project.folder.unregister': {input:z.object({...target,confirm:z.boolean().default(false)}).strict(),output:receipt},
  'project.folder.update': { input: z.object({ ...target,
    name: z.string().min(1).max(256).optional(), description: z.string().nullable().optional(),
    kind: z.enum(['code', 'data', 'docs']).optional(), is_primary: z.boolean().optional(),
    default_branch: z.string().max(256).nullable().optional(), status: z.enum(['active', 'archived', 'stale']).optional(),
    metadata_json: z.record(z.unknown()).nullable().optional(), snapshot_retention_days: z.number().int().nullable().optional(),
    snapshot_max_count: z.number().int().nullable().optional(),
  }).strict(), output: receipt },
  'project.folder.archive': { input: z.object(target).strict(), output: receipt },
  'project.folder.location.activate': { input: z.object({ ...target, location_id: id }).strict(), output: receipt },
  'project.folder.execution_config.create': { input: z.object({ ...target,
    repo_type: configFields.repo_type.default(null), tech_stack_json: configFields.tech_stack_json.default([]),
    important_paths_json: configFields.important_paths_json.default([]), forbidden_paths_json: configFields.forbidden_paths_json.default([]),
    test_commands_json: configFields.test_commands_json.default([]), build_commands_json: configFields.build_commands_json.default([]),
    architecture_boundaries_json: configFields.architecture_boundaries_json.default({}), validation_recipe_id: configFields.validation_recipe_id.default(null),
  }).strict(), output: receipt },
  'project.folder.execution_config.update': { input: z.object({ ...target,
    repo_type: configFields.repo_type.optional(), tech_stack_json: configFields.tech_stack_json.optional(),
    important_paths_json: configFields.important_paths_json.optional(), forbidden_paths_json: configFields.forbidden_paths_json.optional(),
    test_commands_json: configFields.test_commands_json.optional(), build_commands_json: configFields.build_commands_json.optional(),
    architecture_boundaries_json: configFields.architecture_boundaries_json.optional(), validation_recipe_id: configFields.validation_recipe_id.optional(),
  }).strict(), output: receipt },
} as const;
export const PROJECT_FOLDER_TITLES: Record<keyof typeof PROJECT_FOLDER_SCHEMAS, string> = {
  'project.folder.draft.upsert':'Save a private Project Folder recovery draft',
  'project.folder.draft.discard':'Discard an exact private Project Folder draft version',
  'project.folder.unregister':'Unregister a Project Folder without touching its files',
  'project.folder.update': 'Update Project Folder metadata',
  'project.folder.archive': 'Archive a Project Folder',
  'project.folder.location.activate': 'Activate a Project Folder Location',
  'project.folder.execution_config.create': 'Create a Project Folder execution configuration',
  'project.folder.execution_config.update': 'Update a Project Folder execution configuration',
};
