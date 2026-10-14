CREATE TABLE "source_channel_subscription_windows" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"source_channel_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"subscribed_at" timestamp with time zone NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	CONSTRAINT "ck_source_channel_subscription_windows_order" CHECK (unsubscribed_at IS NULL OR unsubscribed_at >= subscribed_at)
);
--> statement-breakpoint
ALTER TABLE "source_channel_user_subscriptions" DROP CONSTRAINT "ck_source_channel_user_subscriptions_window";--> statement-breakpoint
ALTER TABLE "source_channel_subscription_windows" ADD CONSTRAINT "source_channel_subscription_windows_channel_id_fkey" FOREIGN KEY ("source_channel_id","space_id") REFERENCES "public"."source_channels"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_channel_subscription_windows" ADD CONSTRAINT "source_channel_subscription_windows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_source_channel_subscription_windows_reader" ON "source_channel_subscription_windows" USING btree ("space_id","user_id","source_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_source_channel_subscription_windows_open" ON "source_channel_subscription_windows" USING btree ("space_id","source_channel_id","user_id") WHERE unsubscribed_at IS NULL;--> statement-breakpoint
-- Every subscription that is live now has an open period, starting when the
-- subscription row was created (the moment it was first recorded); a period
-- the previous columns already closed keeps its bounds. A row that began as
-- a pending recommendation and was followed later cannot say when: its period
-- starts at the recommendation, so after leaving, its reader may still open
-- items of that space-shared channel first seen while it was only
-- recommended. Starting at `updated_at` instead would cut real history after
-- any later settings change, which is worse.
INSERT INTO "source_channel_subscription_windows" ("id", "space_id", "source_channel_id", "user_id", "subscribed_at", "unsubscribed_at")
SELECT gen_random_uuid()::varchar, "space_id", "source_channel_id", "user_id",
       COALESCE("subscribed_at", "created_at"),
       CASE WHEN "status" = 'subscribed' THEN NULL ELSE "unsubscribed_at" END
  FROM "source_channel_user_subscriptions"
 WHERE "status" = 'subscribed'
    OR ("subscribed_at" IS NOT NULL AND "unsubscribed_at" IS NOT NULL);
