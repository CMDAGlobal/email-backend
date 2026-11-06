CREATE TABLE cmda_pending_triggers (
 contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
 trigger_type text NOT NULL CHECK(trigger_type IN ('list_join','form_submitted')),
 trigger_id uuid NOT NULL,
 PRIMARY KEY(contact_id,trigger_type,trigger_id)
);
