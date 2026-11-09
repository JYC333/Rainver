import {z} from 'zod';
const id=z.string().trim().min(1).max(36);
export const SourceSubscriptionInputSchema=z.object({source_channel_id:id,status:z.enum(['subscribed','muted'])}).strict();
export const SourceRecommendationInputSchema=z.object({source_channel_id:id,decision:z.enum(['subscribed','dismissed','muted'])}).strict();
export const SourceSubscriptionOutputSchema=z.object({source_channel_id:id,status:z.enum(['subscribed','dismissed','muted']),updated_at:z.string().datetime()}).strict();
