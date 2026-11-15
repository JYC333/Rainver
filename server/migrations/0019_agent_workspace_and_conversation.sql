-- rainver:maintenance
CREATE TABLE "project_agent_links" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"space_id" varchar(36) NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"status" varchar(32) NOT NULL,
	"added_by_user_id" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "uq_project_agent_links_project_agent" UNIQUE("space_id","project_id","agent_id"),
	CONSTRAINT "ck_project_agent_links_status" CHECK (status IN ('active', 'removed')),
	CONSTRAINT "ck_project_agent_links_removed_at" CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "project_agent_links" ADD CONSTRAINT "project_agent_links_project_scope_fkey" FOREIGN KEY ("project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent_links" ADD CONSTRAINT "project_agent_links_agent_scope_fkey" FOREIGN KEY ("agent_id","space_id") REFERENCES "public"."agents"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent_links" ADD CONSTRAINT "project_agent_links_added_by_user_id_fkey" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_project_agent_links_agent" ON "project_agent_links" USING btree ("space_id","agent_id","status");--> statement-breakpoint
CREATE INDEX "ix_project_agent_links_project" ON "project_agent_links" USING btree ("space_id","project_id","status","created_at");--> statement-breakpoint
-- Backfill: the Agents a Project already worked with become its Agent list.
-- Only two sources are used, because only they are already Project-wide facts:
-- an Agent created from the Project (agents.project_id), and a specialist on the
-- Project's mainline Room. A limited Room's roster is deliberately not read here:
-- a link derived from it would turn that Room's private roster into a
-- Project-wide fact. Rows without any attributable person are skipped.
INSERT INTO "project_agent_links" ("id","space_id","project_id","agent_id","status","added_by_user_id","created_at","updated_at","removed_at")
SELECT gen_random_uuid()::text, source.space_id, source.project_id, source.agent_id, 'active', source.added_by_user_id, source.created_at, now(), NULL
  FROM (
    SELECT DISTINCT ON (candidate.space_id, candidate.project_id, candidate.agent_id)
           candidate.space_id, candidate.project_id, candidate.agent_id, candidate.added_by_user_id, candidate.created_at
      FROM (
        SELECT agent.space_id, agent.project_id, agent.id AS agent_id,
               COALESCE(agent.owner_user_id, project.owner_user_id) AS added_by_user_id,
               agent.created_at AS created_at
          FROM agents agent
          JOIN projects project ON project.id = agent.project_id AND project.space_id = agent.space_id
         WHERE agent.project_id IS NOT NULL
           AND agent.agent_kind = 'standard'
           AND agent.status <> 'archived'
        UNION ALL
        SELECT member.space_id, room.project_id, member.agent_id,
               COALESCE(agent.owner_user_id, room.created_by_user_id) AS added_by_user_id,
               member.created_at AS created_at
          FROM room_agent_members member
          JOIN rooms room ON room.id = member.room_id AND room.space_id = member.space_id
          JOIN agents agent ON agent.id = member.agent_id AND agent.space_id = member.space_id
         WHERE room.is_mainline
           AND room.status = 'active'
           AND member.role = 'member'
           AND member.status = 'active'
           AND agent.agent_kind = 'standard'
           AND agent.status <> 'archived'
           AND (agent.project_id IS NULL OR agent.project_id = room.project_id)
      ) candidate
     WHERE candidate.added_by_user_id IS NOT NULL
     ORDER BY candidate.space_id, candidate.project_id, candidate.agent_id, candidate.created_at ASC
  ) source
ON CONFLICT ("space_id","project_id","agent_id") DO NOTHING;


RESET search_path;

-- rainver:maintenance
-- Stop old writers before the unified standard-Agent cutover.
ALTER TABLE "agents" ADD COLUMN "access_project_id" varchar(36);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "fk_agents_access_project" FOREIGN KEY ("access_project_id","space_id") REFERENCES "public"."projects"("id","space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_agents_access_project_id" ON "agents" USING btree ("access_project_id");--> statement-breakpoint
-- One-time standard-Agent cutover. Preserve the old Project read gate separately
-- from execution ownership; never turn a Project-shared Agent into Space-wide content.
-- Existing removed links remain removed. Unattributable links are not invented. No session, Run, profile, grant or policy
-- version is rewritten, so pinned history and default profile identities survive.
INSERT INTO project_agent_links
  (id, space_id, project_id, agent_id, status, added_by_user_id, created_at, updated_at)
SELECT gen_random_uuid()::varchar, a.space_id, a.project_id, a.id, 'active',
       COALESCE(a.owner_user_id, p.owner_user_id), a.created_at, a.updated_at
  FROM agents a JOIN projects p ON p.id = a.project_id AND p.space_id = a.space_id
 WHERE a.agent_kind = 'standard' AND a.project_id IS NOT NULL
   AND COALESCE(a.owner_user_id, p.owner_user_id) IS NOT NULL
ON CONFLICT (space_id, project_id, agent_id) DO NOTHING;
--> statement-breakpoint
UPDATE agents SET access_project_id = project_id, project_id = NULL
 WHERE agent_kind = 'standard' AND project_id IS NOT NULL;


RESET search_path;

ALTER TABLE "execution_workspace_runs" ADD COLUMN "checkpoint_recovery_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
-- Preserve old evidence, but move recovery authority to its actual pending binding.
UPDATE execution_workspace_runs b SET checkpoint_recovery_json =
 c.verification_json->'checkpoint_recovery' || jsonb_build_object('launch_sequence', b.launch_sequence)
FROM workspace_change_sets c WHERE b.change_set_id=c.id AND b.space_id=c.space_id
 AND b.checkpoint_state='pending' AND c.verification_json ? 'checkpoint_recovery'
 AND (c.verification_json->'checkpoint_recovery'->>'run_id'=b.run_id OR
  (c.verification_json->'checkpoint_recovery'->>'run_id' IS NULL AND
   (SELECT count(*) FROM execution_workspace_runs only_binding WHERE only_binding.change_set_id=c.id AND only_binding.checkpoint_state='pending')=1));
--> statement-breakpoint
-- The old Host treated a valid no-op takeover receipt as a missing commit.
-- Give that specific, now-readable receipt one normal bounded recovery cycle.
UPDATE execution_workspace_runs SET checkpoint_recovery_json=jsonb_set(checkpoint_recovery_json,'{state}','"requested"'::jsonb)
WHERE checkpoint_state='pending' AND checkpoint_recovery_json->>'error'='workspace_checkpoint_commit_missing';
--> statement-breakpoint
-- Operational retry exhaustion never constitutes a workspace safety violation.
UPDATE workspace_change_sets c SET state='open',revision=c.revision+1,updated_at=now()
FROM execution_workspaces w WHERE c.workspace_id=w.id AND c.space_id=w.space_id
 AND c.state='blocked' AND w.state='ready' AND c.verification_json ? 'checkpoint_recovery'
 AND NOT (c.verification_json ? 'error') AND NOT EXISTS(SELECT 1 FROM task_merges m WHERE m.change_set_id=c.id)
 AND NOT EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.change_set_id=c.id AND b.checkpoint_state='blocked');
--> statement-breakpoint
UPDATE workspace_change_sets SET verification_json=(verification_json-'checkpoint_recovery') ||
 jsonb_build_object('checkpoint_recovery_history',verification_json->'checkpoint_recovery')
WHERE verification_json ? 'checkpoint_recovery';


RESET search_path;

ALTER TABLE "rooms" ADD COLUMN "conversation_defaults_json" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "session_conversation_backends" ADD COLUMN "participating" boolean DEFAULT true NOT NULL;

RESET search_path;
