CREATE TABLE contacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE CHECK (email = lower(email)),
 first_name text NOT NULL DEFAULT '', fields jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'subscribed' CHECK (status IN ('subscribed','unsubscribed')),
 consent_source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lists (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE list_members (list_id uuid REFERENCES lists ON DELETE CASCADE, contact_id uuid REFERENCES contacts ON DELETE CASCADE, PRIMARY KEY(list_id,contact_id));
CREATE INDEX list_members_contact_idx ON list_members(contact_id);
CREATE TABLE suppressions (email text PRIMARY KEY, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE templates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, subject text NOT NULL, html text NOT NULL, design jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, subject text NOT NULL, html text NOT NULL,
 list_id uuid NOT NULL REFERENCES lists, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','completed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES campaigns,
 contact_id uuid NOT NULL REFERENCES contacts, status text NOT NULL DEFAULT 'queued'
 CHECK(status IN ('queued','sending','sent','dry_run','suppressed','unknown','failed')),
 provider_id text, error text, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 UNIQUE(campaign_id,contact_id)
);
CREATE INDEX messages_queue_idx ON messages(created_at) WHERE status='queued';
CREATE TABLE ses_events (id text PRIMARY KEY, event_type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
