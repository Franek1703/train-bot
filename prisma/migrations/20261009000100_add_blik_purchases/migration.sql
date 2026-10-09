ALTER TABLE "watches" ADD COLUMN "purchase_mode" TEXT NOT NULL DEFAULT 'notify',
  ADD COLUMN "purchase_consent" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "purchase_sessions" (
  "id" UUID NOT NULL,
  "watch_id" UUID NOT NULL,
  "availability_check_id" UUID,
  "state" TEXT NOT NULL DEFAULT 'PREPARING',
  "passenger_name" TEXT,
  "seat_assignment" TEXT NOT NULL,
  "price" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "accept_code_until" TIMESTAMP(3) NOT NULL,
  "attempt_id" UUID,
  "order_number" TEXT,
  "intercity_url" TEXT,
  "error_message" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "purchase_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "purchase_sessions_watch_id_fkey" FOREIGN KEY ("watch_id") REFERENCES "watches"("id") ON DELETE CASCADE,
  CONSTRAINT "purchase_sessions_availability_check_id_fkey" FOREIGN KEY ("availability_check_id") REFERENCES "availability_checks"("id") ON DELETE SET NULL
);
CREATE INDEX "purchase_sessions_watch_id_created_at_idx" ON "purchase_sessions"("watch_id", "created_at");
-- All watchers use the single configured Intercity account. Prevent two active checkouts.
CREATE UNIQUE INDEX "purchase_sessions_one_active_account" ON "purchase_sessions" ((1))
  WHERE "state" IN ('PREPARING', 'WAITING_FOR_BLIK', 'PAYMENT_PENDING');

ALTER TABLE "notifications" ADD COLUMN "event_key" TEXT;
CREATE INDEX "notifications_event_key_status_idx" ON "notifications" ("event_key", "status");
