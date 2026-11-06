CREATE TABLE workspace_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text NOT NULL UNIQUE CHECK(email=lower(email)),
 name text NOT NULL,password_hash text NOT NULL,role text NOT NULL CHECK(role IN ('owner','editor','analyst')),
 must_change_password boolean NOT NULL DEFAULT false,disabled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),last_login_at timestamptz
);
CREATE TABLE user_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES workspace_users ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE,csrf_token text NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON user_sessions(user_id);
CREATE INDEX sessions_expiry_idx ON user_sessions(expires_at);
CREATE TABLE audit_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid REFERENCES workspace_users ON DELETE SET NULL,
 actor_name text NOT NULL,action text NOT NULL,resource text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_date_idx ON audit_log(created_at DESC);
ALTER TABLE messages ADD COLUMN resolved_at timestamptz;
ALTER TABLE messages ADD COLUMN resolution_note text;
ALTER TABLE messages ADD COLUMN delivery_generation integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN sending_started_at timestamptz;
UPDATE messages SET sending_started_at=now() WHERE status='sending';
ALTER TABLE automation_enrollments ADD COLUMN waiting_message_id uuid REFERENCES messages ON DELETE SET NULL;
ALTER TABLE automation_enrollments DROP CONSTRAINT automation_enrollments_status_check;
ALTER TABLE automation_enrollments ADD CONSTRAINT automation_enrollments_status_check CHECK(status IN ('active','completed','failed','cancelled'));
CREATE INDEX message_status_created_idx ON messages(status,created_at DESC);
CREATE INDEX messages_sent_idx ON messages(sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX messages_contact_idx ON messages(contact_id,created_at DESC);
CREATE INDEX messages_provider_idx ON messages(provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX contact_created_idx ON contacts(created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX enrollment_automation_idx ON automation_enrollments(automation_id,status);
ALTER TABLE campaigns ADD COLUMN audience_rules jsonb;
