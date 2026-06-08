-- Insights can be archived (hidden from the default view) or deleted.
ALTER TABLE "insights" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "insights_archived_idx" ON "insights" ("archived");
