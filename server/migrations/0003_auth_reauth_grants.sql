CREATE TABLE "auth_reauth_grants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"method" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_for" varchar(64),
	CONSTRAINT "uq_auth_reauth_grants_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "ck_auth_reauth_grants_method" CHECK (method IN ('password', 'google')),
	CONSTRAINT "ck_auth_reauth_grants_consumed" CHECK ((consumed_at IS NULL) = (consumed_for IS NULL))
);
--> statement-breakpoint
ALTER TABLE "auth_reauth_grants" ADD CONSTRAINT "auth_reauth_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_reauth_grants" ADD CONSTRAINT "auth_reauth_grants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."user_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_auth_reauth_grants_session" ON "auth_reauth_grants" USING btree ("session_id","expires_at");