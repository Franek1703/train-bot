CREATE TABLE "watch_artifacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "watch_id" UUID NOT NULL,
    "availability_check_id" UUID,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "file_path" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watch_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "watch_errors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "watch_id" UUID NOT NULL,
    "availability_check_id" UUID,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "current_url" TEXT,
    "page_title" TEXT,
    "body_preview" TEXT,
    "log_artifact_id" UUID,
    "screenshot_artifact_id" UUID,
    "diagnostic_artifact_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watch_errors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "watch_artifacts_watch_id_created_at_idx" ON "watch_artifacts"("watch_id", "created_at");
CREATE INDEX "watch_artifacts_availability_check_id_idx" ON "watch_artifacts"("availability_check_id");
CREATE INDEX "watch_errors_watch_id_created_at_idx" ON "watch_errors"("watch_id", "created_at");
CREATE INDEX "watch_errors_availability_check_id_idx" ON "watch_errors"("availability_check_id");

ALTER TABLE "watch_artifacts" ADD CONSTRAINT "watch_artifacts_watch_id_fkey" FOREIGN KEY ("watch_id") REFERENCES "watches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "watch_artifacts" ADD CONSTRAINT "watch_artifacts_availability_check_id_fkey" FOREIGN KEY ("availability_check_id") REFERENCES "availability_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "watch_errors" ADD CONSTRAINT "watch_errors_watch_id_fkey" FOREIGN KEY ("watch_id") REFERENCES "watches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "watch_errors" ADD CONSTRAINT "watch_errors_availability_check_id_fkey" FOREIGN KEY ("availability_check_id") REFERENCES "availability_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
