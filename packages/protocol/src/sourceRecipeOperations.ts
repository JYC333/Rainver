import {z} from 'zod';
import {SourceChannelSchema,SourceFetchFrequencySchema,SourceChannelCapturePolicySchema} from './sourceChannels.js';
import {SourceRecipeDefinitionSchema,SourceRecipeVersionDTOSchema} from './sourceRecipes.js';
import {CUSTOM_SOURCE_RETENTION_POLICY_VALUES} from './sourceCustomSourceHandlers.js';
const id=z.string().trim().min(1).max(36);
export const SourceRecipeCreateInputSchema=z.object({
  name:z.string().trim().min(1).max(512),endpoint_url:z.string().url().max(8192),
  project_id:id.nullable().optional(),visibility:z.enum(['private','space_shared','selected_users']).optional(),
  source_type:z.enum(['auto','rss','atom','web_list','web_page']).optional(),
  fetch_frequency:SourceFetchFrequencySchema.optional(),next_check_at:z.string().datetime({offset:true}).nullable().optional(),
  schedule_rule:z.record(z.unknown()).nullable().optional(),capture_policy:SourceChannelCapturePolicySchema.optional(),
  retention_policy:z.enum(CUSTOM_SOURCE_RETENTION_POLICY_VALUES).optional(),
  list_selector:z.string().optional(),credential_id:id.nullable().optional(),
  fixture_content:z.string().optional(),config:z.record(z.unknown()).optional(),recipe:SourceRecipeDefinitionSchema.optional(),
}).strict();
export const SourceRecipeCreateOutputSchema=z.object({
  connection:SourceChannelSchema.extend({source_channel_id:id,handler_kind:z.literal('recipe'),status:z.literal('paused')}),
  recipe_version:SourceRecipeVersionDTOSchema,
}).strict();
export type SourceRecipeCreateInput=z.input<typeof SourceRecipeCreateInputSchema>;
export type SourceRecipeCreateOutput=z.output<typeof SourceRecipeCreateOutputSchema>;
