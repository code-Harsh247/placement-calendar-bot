-- Short description lines written by the description step (JSON array of strings),
-- kept so a later update can merge them instead of losing e.g. a meeting link.
ALTER TABLE events ADD COLUMN details TEXT;

-- The notice text, so descriptions can be regenerated after Naarad's 3-day cache expires.
ALTER TABLE notices ADD COLUMN body TEXT;
