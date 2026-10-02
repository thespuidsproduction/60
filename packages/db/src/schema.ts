import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely"

/**
 * Hand-maintained Kysely table types. Keep in step with migrations/*.sql.
 */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>
type Json = ColumnType<unknown, string | undefined | null, string | null>

export const customerRoles = ["CISO", "SECOPS", "GRC", "ADMIN", "AUDITOR", "VIEWER"] as const
export type CustomerRole = (typeof customerRoles)[number]

export const featureStateValues = ["ON", "OFF", "BETA", "INTERNAL"] as const
export type FeatureStateValue = (typeof featureStateValues)[number]

export type ActorType = "user" | "internal_employee" | "system" | "connector"

export interface OrganisationsTable {
  id: Generated<string>
  slug: string
  name: string
  status: Generated<"active" | "suspended" | "offboarding" | "closed">
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface UsersTable {
  id: Generated<string>
  email: string
  display_name: string
  password_hash: string | null
  status: Generated<"active" | "disabled">
  failed_login_count: Generated<number>
  locked_until: NullableTimestamp
  totp_secret_enc: string | null
  totp_enabled_at: NullableTimestamp
  totp_last_step: ColumnType<
    string | null,
    string | number | null | undefined,
    string | number | null
  >
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface UserBackupCodesTable {
  id: Generated<string>
  user_id: string
  code_hash: string
  created_at: Generated<Date>
  used_at: NullableTimestamp
}

export interface MembershipsTable {
  id: Generated<string>
  tenant_id: string
  user_id: string
  role: CustomerRole
  created_at: Generated<Date>
  created_by: string | null
  revoked_at: NullableTimestamp
  revoked_by: string | null
}

export interface SessionsTable {
  id: Generated<string>
  token_hash: Buffer
  user_id: string
  tenant_id: string | null
  created_at: Generated<Date>
  last_seen_at: Generated<Date>
  expires_at: Timestamp
  mfa_verified_at: NullableTimestamp
  reauthenticated_at: NullableTimestamp
  revoked_at: NullableTimestamp
  revoked_reason: string | null
  ip: string | null
  user_agent: string | null
}

export interface AuditEntriesTable {
  seq: Generated<string>
  id: Generated<string>
  tenant_id: string | null
  occurred_at: Generated<Date>
  actor_type: ActorType
  actor_id: string | null
  actor_label: string
  action: string
  target_type: string | null
  target_id: string | null
  session_id: string | null
  ip: string | null
  user_agent: string | null
  old_state: Json
  new_state: Json
  reason: string | null
  correlation_id: string | null
}

export interface FeatureStatesTable {
  id: Generated<string>
  feature_key: string
  environment: "local" | "test" | "staging" | "production"
  tenant_id: string | null
  state: FeatureStateValue
  reason: string | null
  updated_by: string
  updated_at: Generated<Date>
}

export const queueNames = [
  "connector-sync",
  "evidence-process",
  "integrity",
  "incident-analysis",
  "report-generation",
  "notifications",
  "ai-analysis",
  "maintenance",
] as const
export type QueueName = (typeof queueNames)[number]

export type JobStatus = "queued" | "running" | "retrying" | "succeeded" | "dead"

export interface JobRecordsTable {
  id: Generated<string>
  tenant_id: string | null
  queue: QueueName
  job_type: string
  idempotency_key: string
  correlation_id: string
  status: Generated<JobStatus>
  payload: ColumnType<unknown, string | undefined, string>
  attempts: Generated<number>
  max_attempts: Generated<number>
  last_error: string | null
  run_after: Timestamp
  dispatched_at: NullableTimestamp
  started_at: NullableTimestamp
  finished_at: NullableTimestamp
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface OutboxEventsTable {
  seq: Generated<string>
  id: Generated<string>
  tenant_id: string | null
  event_type: string
  aggregate_type: string
  aggregate_id: string
  payload: ColumnType<unknown, string | undefined, string>
  correlation_id: string
  created_at: Generated<Date>
  published_at: NullableTimestamp
}

export const connectorStatuses = [
  "pending",
  "healthy",
  "degraded",
  "failed",
  "disconnected",
] as const
export type ConnectorStatus = (typeof connectorStatuses)[number]

export interface ConnectorsTable {
  id: Generated<string>
  tenant_id: string
  connector_type: string
  display_name: string
  source_tenant: string | null
  status: Generated<ConnectorStatus>
  capabilities: ColumnType<string[], string[] | undefined, string[]>
  granted_permissions: ColumnType<string[], string[] | undefined, string[]>
  connector_version: string
  config: ColumnType<unknown, string | undefined, string>
  credential_ref: string | null
  last_sync_at: NullableTimestamp
  last_success_at: NullableTimestamp
  last_error_at: NullableTimestamp
  last_error: string | null
  consecutive_failures: Generated<number>
  created_at: Generated<Date>
  created_by: string | null
  updated_at: Generated<Date>
  disconnected_at: NullableTimestamp
}

export interface ConnectorCredentialsTable {
  id: Generated<string>
  tenant_id: string
  connector_id: string
  secret_enc: string
  key_id: string
  created_at: Generated<Date>
  created_by: string
  revoked_at: NullableTimestamp
}

export type SyncMode = "baseline" | "incremental"
export type SyncRunStatus = "running" | "succeeded" | "partial" | "failed"

export interface ConnectorSyncRunsTable {
  id: Generated<string>
  tenant_id: string
  connector_id: string
  job_id: string | null
  mode: SyncMode
  status: Generated<SyncRunStatus>
  requested_at: Generated<Date>
  started_at: NullableTimestamp
  finished_at: NullableTimestamp
  source_api: string | null
  cursor_before: Json
  cursor_after: Json
  objects_captured: Generated<number>
  duplicates: Generated<number>
  failures: Generated<number>
  response_state: string | null
  error_summary: string | null
  attempt: Generated<number>
}

export interface ConnectorCursorsTable {
  connector_id: string
  stream: string
  tenant_id: string
  cursor: ColumnType<unknown, string, string>
  updated_at: Generated<Date>
}

export interface Database {
  organisations: OrganisationsTable
  users: UsersTable
  user_backup_codes: UserBackupCodesTable
  memberships: MembershipsTable
  sessions: SessionsTable
  audit_entries: AuditEntriesTable
  feature_states: FeatureStatesTable
  job_records: JobRecordsTable
  outbox_events: OutboxEventsTable
  connectors: ConnectorsTable
  connector_credentials: ConnectorCredentialsTable
  connector_sync_runs: ConnectorSyncRunsTable
  connector_cursors: ConnectorCursorsTable
}

export type Organisation = Selectable<OrganisationsTable>
export type User = Selectable<UsersTable>
export type NewUser = Insertable<UsersTable>
export type UserUpdate = Updateable<UsersTable>
export type Membership = Selectable<MembershipsTable>
export type Session = Selectable<SessionsTable>
export type AuditEntry = Selectable<AuditEntriesTable>
export type FeatureState = Selectable<FeatureStatesTable>
export type JobRecord = Selectable<JobRecordsTable>
export type OutboxEvent = Selectable<OutboxEventsTable>
export type Connector = Selectable<ConnectorsTable>
export type ConnectorSyncRun = Selectable<ConnectorSyncRunsTable>
