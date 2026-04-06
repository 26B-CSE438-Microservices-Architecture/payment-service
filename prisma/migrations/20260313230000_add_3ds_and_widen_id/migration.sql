-- AlterTable: Widen payment id from VarChar(20) to VarChar(50)
ALTER TABLE "payments" ALTER COLUMN "id" SET DATA TYPE VARCHAR(50);

-- AlterTable: Widen payment_events.payment_id from VarChar(20) to VarChar(50)
ALTER TABLE "payment_events" ALTER COLUMN "payment_id" SET DATA TYPE VARCHAR(50);

-- AlterTable: Add 3DS and cancel columns
ALTER TABLE "payments" ADD COLUMN "three_ds_session_token" TEXT;
ALTER TABLE "payments" ADD COLUMN "cancel_reason" TEXT;
