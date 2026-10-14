DROP INDEX "uq_source_items_active_canonical_uri_personal";--> statement-breakpoint
DROP INDEX "uq_source_items_active_source_uri_personal";--> statement-breakpoint
ALTER TABLE "source_item_user_states" ADD COLUMN "read_origin" varchar(32);--> statement-breakpoint
ALTER TABLE "source_channel_user_subscriptions" ADD COLUMN "subscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_channel_user_subscriptions" ADD COLUMN "unsubscribed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_items_active_canonical_uri_personal" ON "source_items" USING btree ("space_id",COALESCE(owner_user_id, ''),"canonical_uri") WHERE canonical_uri IS NOT NULL AND deleted_at IS NULL AND project_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_items_active_source_uri_personal" ON "source_items" USING btree ("space_id",COALESCE(owner_user_id, ''),"source_uri") WHERE source_uri IS NOT NULL AND deleted_at IS NULL AND project_id IS NULL;--> statement-breakpoint
ALTER TABLE "source_item_user_states" ADD CONSTRAINT "ck_source_item_user_states_read_origin" CHECK (read_origin IS NULL OR read_origin IN ('library', 'serendipity'));--> statement-breakpoint
ALTER TABLE "source_channel_user_subscriptions" ADD CONSTRAINT "ck_source_channel_user_subscriptions_window" CHECK ((status <> 'subscribed' OR unsubscribed_at IS NULL) AND (unsubscribed_at IS NULL OR subscribed_at IS NOT NULL));