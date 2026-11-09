import {z} from 'zod';
import {SourceChannelSchema,SourceFetchFrequencySchema,SourceChannelCapturePolicySchema} from './sourceChannels.js';
const id=z.string().trim().min(1).max(36);
/** Human Monitor creation; internal draft/force/research authority is not input. */
export const SourceChannelCreateInputSchema=z.object({
 provider_key:z.string().trim().min(1),source_name:z.string().optional(),name:z.string().optional(),
 project_id:id.nullable().default(null),visibility:z.enum(['private','space_shared','selected_users']).optional(),
 source_connection_id:id.nullable().default(null),credential_id:id.nullable().default(null),
 query:z.record(z.unknown()).default({}),endpoint_url:z.string().url().nullable().default(null),
 fetch_frequency:SourceFetchFrequencySchema.optional(),schedule_rule:z.record(z.unknown()).nullable().default(null),
 status:z.enum(['active','paused']).optional(),capture_policy:SourceChannelCapturePolicySchema.optional(),
 trust_level:z.enum(['trusted','normal','untrusted']).optional(),
 topic_hints:z.array(z.unknown()).optional(),transport_config:z.record(z.unknown()).optional(),config:z.record(z.unknown()).optional(),
 consent:z.record(z.unknown()).optional(),policy:z.record(z.unknown()).optional(),
}).strict();
export const SourceChannelCreateOutputSchema=SourceChannelSchema.extend({
 connector_key:z.string().optional(),research_query_attempt_id:id.nullable(),project_id:id.nullable(),
 source_owner_user_id:id.optional(),created_by_user_id:id,created_at:z.string().datetime(),updated_at:z.string().datetime(),
}).strict();
