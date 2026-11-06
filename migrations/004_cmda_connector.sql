ALTER TABLE lists ADD COLUMN integration text UNIQUE;
CREATE TABLE cmda_members (
 member_id text PRIMARY KEY CHECK(member_id ~ '^[a-f0-9]{24}$'),
 contact_id uuid NOT NULL UNIQUE REFERENCES contacts,
 revision bigint NOT NULL DEFAULT 0,source_hash text NOT NULL,
 marketing_allowed boolean NOT NULL DEFAULT false,active boolean NOT NULL DEFAULT true,
 deleted boolean NOT NULL DEFAULT false,local_optout_sequence bigint NOT NULL DEFAULT 0,
 last_synced_at timestamptz NOT NULL DEFAULT now(),source_updated_at timestamptz
);
CREATE TABLE cmda_contact_history (
 contact_id uuid PRIMARY KEY REFERENCES contacts,member_id text NOT NULL REFERENCES cmda_members ON DELETE CASCADE
);
CREATE TABLE cmda_sync_receipts (
 event_id uuid PRIMARY KEY,member_id text NOT NULL,revision bigint NOT NULL,body_hash text NOT NULL,
 result jsonb NOT NULL,received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cmda_feedback_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 member_id text NOT NULL REFERENCES cmda_members,contact_id uuid NOT NULL REFERENCES contacts,
 email text NOT NULL,type text NOT NULL,event_key text NOT NULL UNIQUE,payload jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','delivered','failed')),
 attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 claimed_at timestamptz,claim_token uuid,last_error text,created_at timestamptz NOT NULL DEFAULT now(),delivered_at timestamptz
);
CREATE INDEX cmda_feedback_due_idx ON cmda_feedback_outbox(next_attempt_at) WHERE status IN ('pending','sending');
CREATE TABLE cmda_request_nonces (id uuid PRIMARY KEY,expires_at timestamptz NOT NULL);
CREATE TABLE cmda_connector_state (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),last_member_sync_at timestamptz,
 last_feedback_delivery_at timestamptz,last_feedback_error text
);
INSERT INTO cmda_connector_state(id) VALUES(true);
