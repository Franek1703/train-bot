CREATE TABLE "watches" (
  "id" UUID NOT NULL,
  "config_key" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "destination" TEXT NOT NULL,
  "travel_date" DATE NOT NULL,
  "train_number" TEXT,
  "departure_time" TEXT,
  "travel_class" INTEGER NOT NULL DEFAULT 2,
  "passengers" INTEGER NOT NULL DEFAULT 1,
  "seat_required" BOOLEAN NOT NULL DEFAULT true,
  "check_interval_minutes" INTEGER NOT NULL DEFAULT 5,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "notification_channel" TEXT NOT NULL DEFAULT 'email',
  "notification_target" TEXT,
  "last_known_status" TEXT,
  "last_checked_at" TIMESTAMP(3),
  "last_notified_at" TIMESTAMP(3),
  "consecutive_errors" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "watches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "watches_config_key_key" ON "watches"("config_key");

CREATE TABLE "availability_checks" (
  "id" UUID NOT NULL,
  "watch_id" UUID NOT NULL,
  "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL,
  "available" BOOLEAN NOT NULL,
  "seat_available" BOOLEAN,
  "price" TEXT,
  "purchase_url" TEXT,
  "train_number" TEXT,
  "departure_time" TEXT,
  "arrival_time" TEXT,
  "raw_status" TEXT,
  "raw_payload" JSONB,
  "error_message" TEXT,
  "screenshot_path" TEXT,
  "duration_ms" INTEGER,
  CONSTRAINT "availability_checks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "availability_checks_watch_id_checked_at_idx" ON "availability_checks"("watch_id", "checked_at");

CREATE TABLE "notifications" (
  "id" UUID NOT NULL,
  "watch_id" UUID NOT NULL,
  "availability_check_id" UUID,
  "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "channel" TEXT NOT NULL,
  "target" TEXT,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'sent',
  "error_message" TEXT,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_watch_id_sent_at_idx" ON "notifications"("watch_id", "sent_at");

ALTER TABLE "availability_checks"
  ADD CONSTRAINT "availability_checks_watch_id_fkey"
  FOREIGN KEY ("watch_id") REFERENCES "watches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_watch_id_fkey"
  FOREIGN KEY ("watch_id") REFERENCES "watches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_availability_check_id_fkey"
  FOREIGN KEY ("availability_check_id") REFERENCES "availability_checks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
