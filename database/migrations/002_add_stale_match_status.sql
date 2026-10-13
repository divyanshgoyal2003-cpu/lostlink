
BEGIN;

ALTER TABLE match_records
    DROP CONSTRAINT IF EXISTS match_records_match_status_check;

ALTER TABLE match_records
    ADD CONSTRAINT chk_match_records_status
    CHECK (
        match_status IN (
            'CANDIDATE',
            'CHAT_ENABLED',
            'CLAIM_PENDING',
            'VERIFIED',
            'REJECTED',
            'RETURNED',
            'STALE'
        )
    );

COMMIT;
