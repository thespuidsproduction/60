-- 0002 Jobs, transactional outbox, connectors.
-- Dev bible §58–60, §70, §104–106, §111; decision D-003 (Redis is never the
-- only record of a job: every job exists in PostgreSQL first).

-- Job records ------------------------------------------------------------------
-- Written in the same transaction as the business change that requires the job,
-- then dispatched to BullMQ (jobId = job_records.id) by the worker dispatcher.

CREATE TABLE job_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid REFERENCES organisations (id),
  queue            text NOT NULL CHECK (queue IN (
                     'connector-sync', 'evidence-process', 'integrity', 'incident-analysis',
                     'report-generation', 'notifications', 'ai-analysis', 'maintenance')),
  job_type         text NOT NULL CHECK (job_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  idempotency_key  text NOT NULL,
  correlation_id   text NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'retrying', 'succeeded', 'dead')),
  -- Identifiers only; never secrets or evidence payloads (§132).
  payload          jsonb NOT NULL DEFAULT '{}',
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 50),
  last_error       text,
  run_after        timestamptz NOT NULL DEFAULT now(),
  dispatched_at    timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (queue, idempotency_key)
);

CREATE INDEX job_records_undispatched ON job_records (run_after)
  WHERE dispatched_at IS NULL AND status IN ('queued', 'retrying');
CREATE INDEX job_records_tenant_failed ON job_records (tenant_id, updated_at DESC)
  WHERE status = 'dead';
CREATE INDEX job_records_correlation ON job_records (correlation_id);

CREATE TRIGGER job_records_touch BEFORE UPDATE ON job_records
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

ALTER TABLE job_records ENABLE ROW LEVEL SECURITY;
-- Tenants may read their own jobs (failed-job visibility in Workspace Admin, §105).
CREATE POLICY job_records_read ON job_records FOR SELECT
  USING (app_is_system() OR (tenant_id IS NOT NULL AND tenant_id = app_current_tenant()));
CREATE POLICY job_records_insert ON job_records FOR INSERT
  WITH CHECK (app_is_system() OR (tenant_id IS NOT NULL AND tenant_id = app_current_tenant()));
CREATE POLICY job_records_update ON job_records FOR UPDATE
  USING (app_is_system()) WITH CHECK (app_is_system());

-- Transactional outbox (§106) -------------------------------------------------

CREATE TABLE outbox_events (
  seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id              uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES organisations (id),
  event_type      text NOT NULL CHECK (event_type ~ '^[A-Z][A-Za-z]+$'),
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  correlation_id  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);

CREATE INDEX outbox_events_unpublished ON outbox_events (seq) WHERE published_at IS NULL;

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY outbox_events_insert ON outbox_events FOR INSERT
  WITH CHECK (app_is_system() OR (tenant_id IS NOT NULL AND tenant_id = app_current_tenant()));
CREATE POLICY outbox_events_system ON outbox_events FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

-- Connectors (§58–60) ---------------------------------------------------------

CREATE TABLE connectors (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES organisations (id),
  connector_type        text NOT NULL CHECK (connector_type ~ '^[a-z0-9_]+$'),
  display_name          text NOT NULL,
  -- External tenant / instance identifier at the source (e.g. Entra tenant ID).
  source_tenant         text,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'healthy', 'degraded', 'failed', 'disconnected')),
  capabilities          text[] NOT NULL DEFAULT '{}',
  granted_permissions   text[] NOT NULL DEFAULT '{}',
  connector_version     text NOT NULL,
  -- Non-secret configuration only. Secrets live in connector_credentials (§59).
  config                jsonb NOT NULL DEFAULT '{}',
  credential_ref        uuid,
  last_sync_at          timestamptz,
  last_success_at       timestamptz,
  last_error_at         timestamptz,
  last_error            text,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users (id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  disconnected_at       timestamptz
);

CREATE INDEX connectors_tenant ON connectors (tenant_id);

CREATE TRIGGER connectors_touch BEFORE UPDATE ON connectors
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;
CREATE POLICY connectors_tenant ON connectors FOR ALL
  USING (app_is_system() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_system() OR tenant_id = app_current_tenant());

-- Encrypted credential material (AES-256-GCM envelope, AAD bound to the connector).
-- System scope only: tenant-scoped application code can never read it.
CREATE TABLE connector_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES organisations (id),
  connector_id  uuid NOT NULL REFERENCES connectors (id),
  secret_enc    text NOT NULL,
  key_id        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  revoked_at    timestamptz
);

CREATE UNIQUE INDEX connector_credentials_active ON connector_credentials (connector_id)
  WHERE revoked_at IS NULL;

ALTER TABLE connectors
  ADD CONSTRAINT connectors_credential_ref_fk
  FOREIGN KEY (credential_ref) REFERENCES connector_credentials (id);

ALTER TABLE connector_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY connector_credentials_system ON connector_credentials FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

-- Every capture attempt is recorded (§111).
CREATE TABLE connector_sync_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES organisations (id),
  connector_id      uuid NOT NULL REFERENCES connectors (id),
  job_id            uuid REFERENCES job_records (id),
  mode              text NOT NULL CHECK (mode IN ('baseline', 'incremental')),
  status            text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  source_api        text,
  cursor_before     jsonb,
  cursor_after      jsonb,
  objects_captured  integer NOT NULL DEFAULT 0,
  duplicates        integer NOT NULL DEFAULT 0,
  failures          integer NOT NULL DEFAULT 0,
  response_state    text,
  error_summary     text,
  attempt           integer NOT NULL DEFAULT 1
);

CREATE INDEX connector_sync_runs_connector ON connector_sync_runs (connector_id, requested_at DESC);

ALTER TABLE connector_sync_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY connector_sync_runs_tenant ON connector_sync_runs FOR ALL
  USING (app_is_system() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_system() OR tenant_id = app_current_tenant());

-- Per-stream incremental cursors.
CREATE TABLE connector_cursors (
  connector_id  uuid NOT NULL REFERENCES connectors (id),
  stream        text NOT NULL,
  tenant_id     uuid NOT NULL REFERENCES organisations (id),
  cursor        jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, stream)
);

ALTER TABLE connector_cursors ENABLE ROW LEVEL SECURITY;
CREATE POLICY connector_cursors_tenant ON connector_cursors FOR ALL
  USING (app_is_system() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_system() OR tenant_id = app_current_tenant());

-- Grants ----------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON job_records, outbox_events, connectors, connector_credentials,
  connector_sync_runs, connector_cursors TO platform_app;
