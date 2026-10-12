BEGIN;
ALTER TABLE "purchase_sessions" ADD COLUMN "deferred_at" TIMESTAMP(3);
DROP INDEX "purchase_sessions_one_active_account";
CREATE UNIQUE INDEX "purchase_sessions_one_active_account" ON "purchase_sessions" ((1))
  WHERE "state" IN ('PREPARING', 'WAITING_FOR_BLIK', 'WAITING_AFTER_DEFERRAL', 'PAYMENT_PENDING');
COMMIT;
