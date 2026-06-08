-- Drive sync: track each source's Drive file + each meeting's Drive subfolder
-- (dedup + loop guard), and a key-value settings table for the connector config.
ALTER TABLE "sources" ADD COLUMN "drive_file_id" TEXT;
ALTER TABLE "sources" ADD CONSTRAINT "sources_drive_file_id_key" UNIQUE ("drive_file_id");

ALTER TABLE "meetings" ADD COLUMN "drive_folder_id" TEXT;
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_drive_folder_id_key" UNIQUE ("drive_folder_id");

CREATE TABLE "settings" (
  "key"        TEXT NOT NULL,
  "value"      TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);
