-- Remove unused 3DS session token column
ALTER TABLE "payments" DROP COLUMN IF EXISTS "three_ds_session_token";

-- Backfill any AWAITING_3DS rows into a terminal state (dev DB cleanup)
UPDATE "payments" SET status = 'FAILED', failure_reason = 'awaiting_3ds_obsolete' WHERE status = 'AWAITING_3DS';
