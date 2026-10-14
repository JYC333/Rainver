ALTER TABLE "agents" ADD COLUMN "source_template_id" varchar(128);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "source_template_version_id" varchar(128);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_source_template_pair" CHECK ((source_template_id IS NULL) = (source_template_version_id IS NULL));