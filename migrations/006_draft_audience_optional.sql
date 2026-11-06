-- Draft campaigns may be saved before an audience list is chosen.
-- Queueing (send/schedule) still requires a list; enforced in campaignAction.
ALTER TABLE campaigns ALTER COLUMN list_id DROP NOT NULL;
