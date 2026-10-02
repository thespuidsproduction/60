-- 0003 Evidence core: raw capture, provenance, normalisation, quarantine,
-- integrity manifests, signing keys, verification.
-- Dev bible §1.3, §14–15, §38–41, §72, §101, §109–112, §120.
--
-- Evidence records are append-only. Nothing about a captured object is ever
-- updated in place: verification outcomes are separate append-only records,
-- and reprocessing with a new transformer adds rows instead of replacing them.

-- Per-tenant human reference sequences (EV-000001, later INC-0001, ...) -------

CREATE TABLE tenant_sequences (
  tenant_id   uuid NOT NULL REFERENCES organisations (id),
  name        text NOT NULL CHECK (name ~ '^[a-z_]+$'),
  next_value  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, name)
);

ALTER TABLE tenant_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_sequences_tenant ON tenant_sequences FOR ALL
  USING (app_is_system() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_system() OR tenant_id = app_current_tenant());

CREATE FUNCTION app_next_reference(p_tenant uuid, p_name text) RETURNS bigint
  LANGUAGE sql
  AS $$
    INSERT INTO tenant_sequences (tenant_id, name, next_value) VALUES (p_tenant, p_name, 2)
    ON CONFLICT (tenant_id, name) DO UPDATE SET next_value = tenant_sequences.next_value + 1
    RETURNING next_value - 1
  $$;

-- Raw evidence objects (§110) --------------------------------------------------

CREATE TABLE raw_evidence_objects (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES organisations (id),
  reference           text NOT NULL CHECK (reference ~ '^EV-[0-9]{6,}$'),
  source              text NOT NULL,
  connector_id        uuid REFERENCES connectors (id),
  sync_run_id         uuid REFERENCES connector_sync_runs (id),
  source_tenant       text NOT NULL,
  source_object_id    text NOT NULL,
  source_event_id     text,
  object_type         text NOT NULL,
  source_api          text NOT NULL,
  media_type          text NOT NULL DEFAULT 'application/json',
  -- Time model (§39): occurred = source timestamp, observed = captured by the
  -- connector, ingested = durably stored by the platform.
  occurred_at         timestamptz,
  observed_at         timestamptz NOT NULL,
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  raw_sha256          text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes          integer NOT NULL CHECK (size_bytes >= 0),
  storage_object_key  text NOT NULL UNIQUE,
  trust_level         text NOT NULL CHECK (trust_level IN ('A', 'B', 'C', 'D', 'E')),
  classification      text NOT NULL DEFAULT 'SECURITY_SENSITIVE'
                      CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL',
                        'CUSTOMER_SENSITIVE', 'SECURITY_SENSITIVE', 'HIGHLY_RESTRICTED')),
  retention_class     text NOT NULL DEFAULT 'operational_evidence',
  retention_until     timestamptz,
  -- source + source tenant + (event id | object id + payload hash): §71.
  dedup_key           text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference),
  UNIQUE (tenant_id, dedup_key)
);

CREATE INDEX raw_evidence_tenant_ingested ON raw_evidence_objects (tenant_id, ingested_at DESC);
CREATE INDEX raw_evidence_tenant_source ON raw_evidence_objects (tenant_id, source, ingested_at);

CREATE TRIGGER raw_evidence_append_only BEFORE UPDATE OR DELETE ON raw_evidence_objects
  FOR EACH ROW EXECUTE FUNCTION app_reject_mutation();
CREATE TRIGGER raw_evidence_no_truncate BEFORE TRUNCATE ON raw_evidence_objects
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_mutation();

ALTER TABLE raw_evidence_objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY raw_evidence_read ON raw_evidence_objects FOR SELECT
  USING (app_is_system() OR tenant_id = app_current_tenant());
CREATE POLICY raw_evidence_insert ON raw_evidence_objects FOR INSERT
  WITH CHECK (app_is_system() OR tenant_id = app_current_tenant());

-- Quarantined objects: preserved raw, never silently dropped (§1.3).
CREATE TABLE evidence_quarantine (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES organisations (id),
  connector_id        uuid REFERENCES connectors (id),
  sync_run_id         uuid REFERENCES connector_sync_runs (id),
  reason              text NOT NULL,
  raw_sha256          text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes          integer NOT NULL,
  storage_object_key  text NOT NULL UNIQUE,
  captured_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER evidence_quarantine_append_only BEFORE UPDATE OR DELETE ON evidence_quarantine
  FOR EACH ROW EXECUTE FUNCTION app_reject_mutation();

ALTER TABLE evidence_quarantine ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidence_quarantine_read ON evidence_quarantine FOR SELECT
  USING (app_is_system() OR tenant_id = app_current_tenant());
CREATE POLICY evidence_quarantine_insert ON evidence_quarantine FOR INSERT
  WITH CHECK (app_is_system());

-- Canonical evidence events (§39, §72, §112) -----------------------------------
-- One row per (raw object, transformer version). Reprocessing adds rows; older
-- interpretations remain attributable.

CREATE TABLE evidence_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES organisations (id),
  raw_object_id        uuid NOT NULL REFERENCES raw_evidence_objects (id),
  event_type           text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]*$'),
  category             text NOT NULL,
  severity             text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  description          text NOT NULL,
  source_type          text NOT NULL,
  source_id            uuid REFERENCES connectors (id),
  source_event_id      text,
  subject_type         text,
  subject_id           text,
  asset_type           text,
  asset_id             text,
  occurred_at          timestamptz,
  observed_at          timestamptz NOT NULL,
  ingested_at          timestamptz NOT NULL,
  time_confidence      text NOT NULL CHECK (time_confidence IN ('source', 'observed', 'unknown')),
  raw_sha256           text NOT NULL,
  normalized_payload   jsonb NOT NULL,
  normalized_sha256    text NOT NULL CHECK (normalized_sha256 ~ '^[0-9a-f]{64}$'),
  schema_version       text NOT NULL CHECK (schema_version ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.v[0-9]+$'),
  transformer          text NOT NULL,
  transformer_version  text NOT NULL,
  trust_level          text NOT NULL CHECK (trust_level IN ('A', 'B', 'C', 'D', 'E')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raw_object_id, transformer, transformer_version)
);

CREATE INDEX evidence_events_tenant_occurred ON evidence_events (tenant_id, occurred_at DESC);
CREATE INDEX evidence_events_tenant_type ON evidence_events (tenant_id, event_type);
CREATE INDEX evidence_events_tenant_subject ON evidence_events (tenant_id, subject_id);
CREATE INDEX evidence_events_tenant_asset ON evidence_events (tenant_id, asset_id);
CREATE INDEX evidence_events_raw ON evidence_events (raw_object_id, created_at DESC);

CREATE TRIGGER evidence_events_append_only BEFORE UPDATE OR DELETE ON evidence_events
  FOR EACH ROW EXECUTE FUNCTION app_reject_mutation();

ALTER TABLE evidence_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidence_events_read ON evidence_events FOR SELECT
  USING (app_is_system() OR tenant_id = app_current_tenant());
CREATE POLICY evidence_events_insert ON evidence_events FOR INSERT
  WITH CHECK (app_is_system());

-- Signing keys (§120): public halves only. Private keys never enter the database.
CREATE TABLE signing_keys (
  id           text PRIMARY KEY CHECK (id ~ '^[a-z0-9_-]{1,32}$'),
  algorithm    text NOT NULL CHECK (algorithm = 'ed25519'),
  public_key   text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz
);

ALTER TABLE signing_keys ENABLE ROW LEVEL SECURITY;
-- Public keys are public: every tenant may read them to verify manifests.
CREATE POLICY signing_keys_read ON signing_keys FOR SELECT USING (true);
CREATE POLICY signing_keys_write ON signing_keys FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

-- Integrity manifests (§41): Merkle root over a batch, signed, chained per tenant.
CREATE TABLE integrity_manifests (
  id                      uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL REFERENCES organisations (id),
  sequence                bigint NOT NULL,
  manifest_version        integer NOT NULL,
  source                  text NOT NULL,
  period_start            timestamptz NOT NULL,
  period_end              timestamptz NOT NULL,
  item_count              integer NOT NULL CHECK (item_count > 0),
  merkle_root             text NOT NULL CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
  previous_manifest_id    uuid REFERENCES integrity_manifests (id),
  previous_manifest_hash  text,
  manifest_sha256         text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  signature               text NOT NULL,
  signing_key_id          text NOT NULL REFERENCES signing_keys (id),
  storage_object_key      text NOT NULL UNIQUE,
  created_at              timestamptz NOT NULL,
  UNIQUE (tenant_id, sequence),
  CHECK ((sequence = 1) = (previous_manifest_id IS NULL))
);

CREATE TRIGGER integrity_manifests_append_only BEFORE UPDATE OR DELETE ON integrity_manifests
  FOR EACH ROW EXECUTE FUNCTION app_reject_mutation();

ALTER TABLE integrity_manifests ENABLE ROW LEVEL SECURITY;
CREATE POLICY integrity_manifests_read ON integrity_manifests FOR SELECT
  USING (app_is_system() OR tenant_id = app_current_tenant());
CREATE POLICY integrity_manifests_insert ON integrity_manifests FOR INSERT
  WITH CHECK (app_is_system());

CREATE TABLE integrity_manifest_items (
  manifest_id    uuid NOT NULL REFERENCES integrity_manifests (id),
  leaf_index     integer NOT NULL,
  raw_object_id  uuid NOT NULL UNIQUE REFERENCES raw_evidence_objects (id),
  tenant_id      uuid NOT NULL REFERENCES organisations (id),
  raw_sha256     text NOT NULL,
  PRIMARY KEY (manifest_id, leaf_index)
);

CREATE TRIGGER integrity_manifest_items_append_only BEFORE UPDATE OR DELETE ON integrity_manifest_items
  FOR EACH ROW EXECUTE FUNCTION app_reject_mutation();

ALTER TABLE integrity_manifest_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY integrity_manifest_items_read ON integrity_manifest_items FOR SELECT
  USING (app_is_system() OR tenant_id = app_current_tenant());
CREATE POLICY integrity_manifest_items_insert ON integrity_manifest_items FOR INSERT
  WITH CHECK (app_is_system());

-- Verification outcomes (§15): append-only history of every check run.
CREATE TABLE evidence_verifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES organisations (id),
  raw_object_id  uuid NOT NULL REFERENCES raw_evidence_objects (id),
  manifest_id    uuid REFERENCES integrity_manifests (id),
  result         text NOT NULL CHECK (result IN ('verified', 'pending', 'failed')),
  checks         jsonb NOT NULL,
  verified_by    text NOT NULL,
  verified_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX evidence_verifications_object ON evidence_verifications (raw_object_id, verified_at DESC);

CREATE TRIGGER evidence_verifications_append_only BEFORE UPDATE OR DELETE ON evidence_verifications
  FOR EACH ROW EXECUTE FUNCTION app_reject_mutation();

ALTER TABLE evidence_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidence_verifications_read ON evidence_verifications FOR SELECT
  USING (app_is_system() OR tenant_id = app_current_tenant());
CREATE POLICY evidence_verifications_insert ON evidence_verifications FOR INSERT
  WITH CHECK (app_is_system() OR tenant_id = app_current_tenant());

-- Grants ----------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON tenant_sequences TO platform_app;
GRANT EXECUTE ON FUNCTION app_next_reference(uuid, text) TO platform_app;
GRANT SELECT, INSERT ON raw_evidence_objects, evidence_quarantine, evidence_events,
  integrity_manifests, integrity_manifest_items, evidence_verifications TO platform_app;
GRANT SELECT, INSERT, UPDATE ON signing_keys TO platform_app;
