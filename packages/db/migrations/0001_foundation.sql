-- 0001 Foundation: tenancy, users, memberships, sessions, audit log, feature states.
-- Dev bible §37, §63, §67, §101, §107.
--
-- Access model
--   * Migrations run as the database owner.
--   * The application connects as a login role that is a member of `platform_app`
--     (no superuser, no BYPASSRLS), so row-level security always applies.
--   * Tenant context: `app.tenant_id` (transaction-local), set by withTenant().
--   * System context: `app.scope = 'system'`, set only by withSystem() for
--     cross-tenant server code (authentication, workers, internal Control Plane).
--   RLS is defence in depth; application-level authorisation remains mandatory.

DO $$
BEGIN
  CREATE ROLE platform_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

GRANT USAGE ON SCHEMA public TO platform_app;

-- Context helpers -------------------------------------------------------------

CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_is_system() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.scope', true), '') = 'system' $$;

-- Raises on UPDATE / DELETE / TRUNCATE for append-only tables (§1.8, §67).
CREATE FUNCTION app_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE FUNCTION app_touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Organisations (tenants) -----------------------------------------------------

CREATE TABLE organisations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'suspended', 'offboarding', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER organisations_touch BEFORE UPDATE ON organisations
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organisations_read ON organisations FOR SELECT
  USING (app_is_system() OR id = app_current_tenant());
CREATE POLICY organisations_write ON organisations FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

-- Users (global identities; tenant access is via memberships) ------------------

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL CHECK (position('@' IN email) > 1),
  display_name        text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  password_hash       text,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_login_count  integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  -- TOTP secret encrypted at rest (AES-256-GCM envelope; key id embedded).
  totp_secret_enc     text,
  totp_enabled_at     timestamptz,
  -- Last accepted TOTP time-step, to reject code replay.
  totp_last_step      bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();

-- Backup codes are stored hashed only.
CREATE TABLE user_backup_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  code_hash   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);

CREATE INDEX user_backup_codes_user ON user_backup_codes (user_id) WHERE used_at IS NULL;

ALTER TABLE user_backup_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_backup_codes_system ON user_backup_codes FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

-- Memberships: user ↔ tenant with a customer role (§27, §64).
-- Role changes revoke the old row and insert a new one (non-destructive history).
CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES organisations (id),
  user_id     uuid NOT NULL REFERENCES users (id),
  role        text NOT NULL CHECK (role IN ('CISO', 'SECOPS', 'GRC', 'ADMIN', 'AUDITOR', 'VIEWER')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users (id),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users (id)
);

CREATE UNIQUE INDEX memberships_active_unique ON memberships (tenant_id, user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX memberships_user ON memberships (user_id);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant ON memberships FOR ALL
  USING (app_is_system() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_system() OR tenant_id = app_current_tenant());

-- Users are visible to system code, to themselves, and to tenants they belong to.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users FOR SELECT
  USING (
    app_is_system()
    OR id = app_current_user()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id AND m.tenant_id = app_current_tenant()
    )
  );
CREATE POLICY users_write ON users FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

-- Sessions: opaque random token in an HTTP-only cookie; only its SHA-256 is stored.
CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash          bytea NOT NULL UNIQUE,
  user_id             uuid NOT NULL REFERENCES users (id),
  tenant_id           uuid REFERENCES organisations (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  mfa_verified_at     timestamptz,
  reauthenticated_at  timestamptz,
  revoked_at          timestamptz,
  revoked_reason      text,
  ip                  inet,
  user_agent          text
);

CREATE INDEX sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_system ON sessions FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

-- Audit log (§67): append-only, separate from imported cyber evidence.
-- tenant_id is NULL for platform-level (internal) events.
CREATE TABLE audit_entries (
  seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id              uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES organisations (id),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_type      text NOT NULL
                  CHECK (actor_type IN ('user', 'internal_employee', 'system', 'connector')),
  actor_id        uuid,
  actor_label     text NOT NULL,
  action          text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  target_type     text,
  target_id       text,
  session_id      uuid,
  ip              inet,
  user_agent      text,
  old_state       jsonb,
  new_state       jsonb,
  reason          text,
  correlation_id  text
);

CREATE INDEX audit_entries_tenant_time ON audit_entries (tenant_id, occurred_at DESC);
CREATE INDEX audit_entries_target ON audit_entries (target_type, target_id);

CREATE TRIGGER audit_entries_append_only BEFORE UPDATE OR DELETE ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION app_reject_mutation();
CREATE TRIGGER audit_entries_no_truncate BEFORE TRUNCATE ON audit_entries
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_mutation();

ALTER TABLE audit_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_entries_read ON audit_entries FOR SELECT
  USING (app_is_system() OR (tenant_id IS NOT NULL AND tenant_id = app_current_tenant()));
CREATE POLICY audit_entries_insert ON audit_entries FOR INSERT
  WITH CHECK (app_is_system() OR (tenant_id IS NOT NULL AND tenant_id = app_current_tenant()));

-- Feature states (§35, §89): exposure control, per environment and optionally per tenant.
CREATE TABLE feature_states (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key  text NOT NULL CHECK (feature_key ~ '^[a-z0-9]+(\.[a-z0-9_]+)*$'),
  environment  text NOT NULL CHECK (environment IN ('local', 'test', 'staging', 'production')),
  tenant_id    uuid REFERENCES organisations (id),
  state        text NOT NULL CHECK (state IN ('ON', 'OFF', 'BETA', 'INTERNAL')),
  reason       text,
  updated_by   text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (feature_key, environment, tenant_id)
);

ALTER TABLE feature_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY feature_states_read ON feature_states FOR SELECT
  USING (app_is_system() OR tenant_id IS NULL OR tenant_id = app_current_tenant());
CREATE POLICY feature_states_write ON feature_states FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

-- Grants ----------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON organisations, users, memberships, sessions, feature_states
  TO platform_app;
GRANT SELECT, INSERT, UPDATE ON user_backup_codes TO platform_app;
GRANT DELETE ON feature_states TO platform_app;
-- Audit log: insert and read only. No UPDATE, DELETE or TRUNCATE for the application.
GRANT SELECT, INSERT ON audit_entries TO platform_app;
