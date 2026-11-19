CREATE TABLE "plugin_diary"."entries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"entry_date" date NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entries_user_date" UNIQUE("user_id","entry_date"),
	CONSTRAINT "entries_user_id_id" UNIQUE("user_id","id"),
	CONSTRAINT "entries_user_id_nonempty" CHECK (length(trim("plugin_diary"."entries"."user_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "plugin_diary"."reflections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"reflection_date" date NOT NULL,
	"content" text NOT NULL,
	"ai_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reflections_entry_date" UNIQUE("entry_id","reflection_date")
);
--> statement-breakpoint
ALTER TABLE "plugin_diary"."reflections" ADD CONSTRAINT "reflections_entry_fk" FOREIGN KEY ("user_id","entry_id") REFERENCES "plugin_diary"."entries"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entries_user_month_day_idx" ON "plugin_diary"."entries" USING btree ("user_id",extract(month from "entry_date"),extract(day from "entry_date"));