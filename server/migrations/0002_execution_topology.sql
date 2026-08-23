-- P1 execution topology upgrade.
--
-- 0001 is the immutable pre-topology baseline. This migration is deliberately
-- additive/backfilling: existing hosts, folders, threads, runs, and remote
-- messages keep their identities while the physical checkout becomes a
-- WorkspaceLocation. Readiness is conservative during the upgrade and must be
-- refreshed by the server/daemon before a location is dispatchable.

CREATE TABLE machines (
  id varchar(36) PRIMARY KEY NOT NULL,
  owner_user_id varchar(36),
  display_name varchar(120) NOT NULL,
  device_kind varchar(32),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE machines
  ADD CONSTRAINT machines_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX ix_machines_owner_user_id ON machines(owner_user_id);

ALTER TABLE hosts
  ADD COLUMN machine_id varchar(36),
  ADD COLUMN environment_kind varchar(24);

-- The old model had one physical host per Folder, so one Machine per existing
-- Host is the lossless migration. Later pairing can intentionally join hosts
-- (for example Windows-native and WSL) to one Machine.
INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
SELECT h.id, h.owner_user_id, h.name,
       CASE WHEN h.kind = 'server' THEN 'server' ELSE h.platform END,
       h.created_at, h.updated_at
  FROM hosts h;

UPDATE hosts
   SET machine_id = id,
       environment_kind = CASE
         WHEN kind = 'server' THEN 'server'
         WHEN platform = 'win32' THEN 'windows_native'
         WHEN platform = 'darwin' THEN 'macos_native'
         ELSE 'linux_native'
       END;

ALTER TABLE hosts
  ALTER COLUMN machine_id SET NOT NULL,
  ALTER COLUMN environment_kind SET NOT NULL;
ALTER TABLE hosts
  ADD CONSTRAINT uq_hosts_id_kind UNIQUE (id, kind),
  ADD CONSTRAINT hosts_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES machines(id),
  ADD CONSTRAINT ck_hosts_environment_kind CHECK (environment_kind IN ('windows_native', 'wsl', 'linux_native', 'macos_native', 'vm', 'container', 'server')),
  ADD CONSTRAINT ck_hosts_server_environment CHECK (kind <> 'server' OR environment_kind = 'server');
CREATE INDEX ix_hosts_machine_id ON hosts(machine_id);

CREATE TABLE workspace_locations (
  id varchar(36) PRIMARY KEY NOT NULL,
  space_id varchar(36) NOT NULL,
  project_folder_id varchar(36) NOT NULL,
  execution_host_id varchar(36) NOT NULL,
  execution_host_kind varchar(16) NOT NULL,
  display_path varchar(1024),
  root_path varchar(1024),
  branch varchar(256),
  git_head varchar(64),
  dirty boolean,
  execution_ready boolean NOT NULL DEFAULT false,
  status varchar(32) NOT NULL DEFAULT 'active',
  preferred boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT uq_workspace_locations_id_folder UNIQUE (id, project_folder_id),
  CONSTRAINT ck_workspace_locations_status CHECK (status IN ('active', 'archived', 'stale')),
  CONSTRAINT ck_workspace_locations_execution_host_kind CHECK (execution_host_kind IN ('server', 'remote')),
  CONSTRAINT ck_workspace_locations_remote_no_root_path CHECK (execution_host_kind <> 'remote' OR root_path IS NULL)
);

-- One old Folder row maps to exactly one Location. Keep the old physical
-- values, but do not infer readiness from their existence: a path may have
-- disappeared while the database was offline.
INSERT INTO workspace_locations (
  id, space_id, project_folder_id, execution_host_id, execution_host_kind,
  display_path, root_path, execution_ready, status, preferred, created_at, updated_at
)
SELECT pf.id, pf.space_id, pf.id, pf.host_id, pf.host_kind,
       pf.display_path, pf.root_path, false, pf.status, true, pf.created_at, pf.updated_at
  FROM project_folders pf;

ALTER TABLE workspace_locations
  ADD CONSTRAINT workspace_locations_space_id_fkey
    FOREIGN KEY (space_id) REFERENCES spaces(id),
  ADD CONSTRAINT workspace_locations_project_folder_id_fkey
    FOREIGN KEY (project_folder_id, space_id) REFERENCES project_folders(id, space_id) ON DELETE CASCADE,
  ADD CONSTRAINT workspace_locations_execution_host_id_fkey
    FOREIGN KEY (execution_host_id, execution_host_kind) REFERENCES hosts(id, kind);
CREATE INDEX ix_workspace_locations_project_folder_id ON workspace_locations(project_folder_id);
CREATE INDEX ix_workspace_locations_execution_host_id ON workspace_locations(execution_host_id);
CREATE INDEX ix_workspace_locations_status ON workspace_locations(status);
CREATE UNIQUE INDEX uq_workspace_locations_one_preferred_per_folder
  ON workspace_locations(project_folder_id) WHERE preferred;
CREATE UNIQUE INDEX uq_workspace_locations_space_root_path
  ON workspace_locations(space_id, root_path) WHERE root_path IS NOT NULL;

ALTER TABLE runs
  ADD COLUMN workspace_location_id varchar(36),
  ADD COLUMN trust_mode varchar(16);

ALTER TABLE host_task_threads
  ADD COLUMN workspace_location_id varchar(36);

UPDATE host_task_threads t
   SET workspace_location_id = wl.id
  FROM workspace_locations wl
 WHERE wl.project_folder_id = t.project_folder_id
   AND wl.execution_host_id = t.host_id;

ALTER TABLE host_task_threads
  DROP CONSTRAINT host_task_threads_project_folder_id_fkey,
  DROP CONSTRAINT host_task_threads_host_id_fkey,
  DROP CONSTRAINT uq_host_task_threads_id_folder,
  ALTER COLUMN workspace_location_id SET NOT NULL;
ALTER TABLE host_task_threads
  DROP COLUMN project_folder_id,
  DROP COLUMN host_id;
ALTER TABLE host_task_threads
  ADD CONSTRAINT uq_host_task_threads_id_location UNIQUE (id, workspace_location_id),
  ADD CONSTRAINT host_task_threads_workspace_location_id_fkey
    FOREIGN KEY (workspace_location_id) REFERENCES workspace_locations(id) ON DELETE CASCADE;
CREATE INDEX ix_host_task_threads_workspace_location_id ON host_task_threads(workspace_location_id);

ALTER TABLE host_thread_events ADD COLUMN project_id varchar(36);
UPDATE host_thread_events e
   SET project_id = pf.project_id
  FROM host_task_threads t
  JOIN workspace_locations wl ON wl.id = t.workspace_location_id
  JOIN project_folders pf ON pf.id = wl.project_folder_id
 WHERE e.host_task_thread_id = t.id;
ALTER TABLE host_thread_events
  ALTER COLUMN project_id SET NOT NULL,
  ADD CONSTRAINT host_thread_events_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id);
CREATE INDEX ix_host_thread_events_project_id ON host_thread_events(project_id);

ALTER TABLE host_thread_messages ADD COLUMN task_id varchar(36);

-- Messages that were already attached to a Run can reuse the existing
-- task_runs link. Older queued messages had no Task at all, so create one
-- durable, space-shared migration Task for each such message rather than
-- dropping the message or inventing a nullable canonical owner.
UPDATE host_thread_messages m
   SET task_id = tr.task_id
  FROM task_runs tr
 WHERE m.run_id = tr.run_id
   AND m.task_id IS NULL;

INSERT INTO tasks (
  id, space_id, project_folder_id, project_id, task_role, title, description,
  task_type, status, priority, risk_level, created_by_user_id,
  created_at, updated_at, visibility, access_level
)
SELECT (
         substr(md5('host-message-task:' || m.id), 1, 8) || '-' ||
         substr(md5('host-message-task:' || m.id), 9, 4) || '-' ||
         substr(md5('host-message-task:' || m.id), 13, 4) || '-' ||
         substr(md5('host-message-task:' || m.id), 17, 4) || '-' ||
         substr(md5('host-message-task:' || m.id), 21, 12)
       ), pf.space_id, pf.id, pf.project_id, 'source',
       left(CASE WHEN btrim(m.prompt) = '' THEN 'Migrated remote dispatch' ELSE m.prompt END, 512),
       'Created while migrating a pre-P1 remote dispatch message.',
       'coding', CASE WHEN m.status = 'dispatched' THEN 'in_progress' ELSE 'inbox' END,
       'normal', 'low', m.created_by_user_id, m.created_at, m.updated_at,
       'space_shared', 'full'
  FROM host_thread_messages m
  JOIN host_task_threads t ON t.id = m.host_task_thread_id
  JOIN workspace_locations wl ON wl.id = t.workspace_location_id
  JOIN project_folders pf ON pf.id = wl.project_folder_id
 WHERE m.task_id IS NULL;

UPDATE host_thread_messages m
   SET task_id = q.task_id
  FROM (
    SELECT m2.id,
           substr(md5('host-message-task:' || m2.id), 1, 8) || '-' ||
           substr(md5('host-message-task:' || m2.id), 9, 4) || '-' ||
           substr(md5('host-message-task:' || m2.id), 13, 4) || '-' ||
           substr(md5('host-message-task:' || m2.id), 17, 4) || '-' ||
           substr(md5('host-message-task:' || m2.id), 21, 12) AS task_id
      FROM host_thread_messages m2
      JOIN host_task_threads th ON th.id = m2.host_task_thread_id
      JOIN workspace_locations wl ON wl.id = th.workspace_location_id
      JOIN project_folders pf ON pf.id = wl.project_folder_id
     WHERE m2.task_id IS NULL
  ) q
 WHERE m.id = q.id;

INSERT INTO task_runs (id, space_id, task_id, run_id, role, created_at)
SELECT gen_random_uuid()::varchar, t.space_id, m.task_id, m.run_id, 'primary', m.created_at
  FROM host_thread_messages m
  JOIN tasks t ON t.id = m.task_id
 WHERE m.run_id IS NOT NULL
ON CONFLICT (task_id, run_id) DO NOTHING;

-- A legacy dispatched message may already point at a terminal Run. There is
-- no terminal event to replay after this one-shot migration, so settle every
-- migrated Task from the complete set of linked Run rows while the old
-- message/Run relationship is still available.
WITH task_state AS (
  SELECT tr.task_id,
         tr.space_id,
         bool_and(r.status IN ('succeeded', 'failed', 'degraded', 'cancelled', 'orphaned')) AS all_terminal,
         bool_or(r.status IN ('failed', 'degraded', 'cancelled', 'orphaned')) AS has_failure,
         bool_or(r.status = 'cancelled') AS has_cancelled
    FROM task_runs tr
    JOIN runs r ON r.id = tr.run_id AND r.space_id = tr.space_id
   WHERE EXISTS (
     SELECT 1 FROM host_thread_messages m
      WHERE m.task_id = tr.task_id AND m.run_id = tr.run_id
   )
   GROUP BY tr.task_id, tr.space_id
)
UPDATE tasks t
   SET status = CASE WHEN s.has_failure THEN 'blocked' ELSE 'done' END,
       completed_at = CASE WHEN s.has_failure THEN NULL ELSE COALESCE(t.completed_at, now()) END,
       cancelled_at = CASE WHEN s.has_failure AND s.has_cancelled THEN COALESCE(t.cancelled_at, now()) ELSE t.cancelled_at END,
       blocked_reason = CASE WHEN s.has_failure THEN COALESCE(t.blocked_reason, 'A linked Run ended unsuccessfully') ELSE NULL END,
       updated_at = now()
  FROM task_state s
 WHERE t.id = s.task_id
   AND t.space_id = s.space_id
   AND s.all_terminal;

-- The INSERT/UPDATE pair above is deterministic for the rows it creates; a
-- defensive failure makes the migration stop rather than silently losing a
-- message's Task ownership.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM host_thread_messages WHERE task_id IS NULL) THEN
    RAISE EXCEPTION 'P1 migration could not backfill host_thread_messages.task_id';
  END IF;
END $$;

ALTER TABLE host_thread_messages
  ALTER COLUMN task_id SET NOT NULL,
  ADD CONSTRAINT host_thread_messages_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES tasks(id);
CREATE INDEX ix_host_thread_messages_task_id ON host_thread_messages(task_id);

-- Runs inherit the exact Location used by their old (Folder, Host) binding.
UPDATE runs r
   SET workspace_location_id = wl.id,
       trust_mode = CASE WHEN wl.execution_host_kind = 'server' THEN 'sandboxed' ELSE 'trusted_host' END
  FROM workspace_locations wl
 WHERE r.project_folder_id = wl.project_folder_id
   AND (r.workspace_location_id IS NULL)
   AND (
     r.host_task_thread_id IS NULL
     OR EXISTS (
       SELECT 1 FROM host_task_threads ht
        WHERE ht.id = r.host_task_thread_id
          AND ht.workspace_location_id = wl.id
     )
   );

ALTER TABLE runs
  ADD CONSTRAINT ck_runs_trust_mode CHECK (trust_mode IS NULL OR trust_mode IN ('sandboxed', 'trusted_host')),
  ADD CONSTRAINT runs_workspace_location_id_fkey
    FOREIGN KEY (workspace_location_id, project_folder_id)
    REFERENCES workspace_locations(id, project_folder_id);
CREATE INDEX ix_runs_workspace_location_id ON runs(workspace_location_id);

ALTER TABLE project_folders
  DROP CONSTRAINT project_folders_host_id_fkey,
  DROP CONSTRAINT ck_project_folders_host_kind,
  DROP CONSTRAINT ck_project_folders_remote_no_root_path,
  DROP COLUMN host_id,
  DROP COLUMN host_kind,
  DROP COLUMN root_path,
  DROP COLUMN display_path;
