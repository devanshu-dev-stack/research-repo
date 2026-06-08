-- Meetings: group the files uploaded together as one research session.
CREATE TABLE "meetings" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID,
  "title"      TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "meetings_project_id_idx" ON "meetings" ("project_id");

ALTER TABLE "meetings"
  ADD CONSTRAINT "meetings_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Link sources to their meeting.
ALTER TABLE "sources" ADD COLUMN "meeting_id" UUID;

CREATE INDEX "sources_meeting_id_idx" ON "sources" ("meeting_id");

ALTER TABLE "sources"
  ADD CONSTRAINT "sources_meeting_id_fkey"
  FOREIGN KEY ("meeting_id") REFERENCES "meetings" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
