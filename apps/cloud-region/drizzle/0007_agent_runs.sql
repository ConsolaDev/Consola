ALTER TABLE "cloud_session" ALTER COLUMN "person_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_session" ALTER COLUMN "runner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_session" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "cloud_session" ADD COLUMN "agent_run" text;--> statement-breakpoint
CREATE INDEX "cloud_session_workspace" ON "cloud_session" USING btree ("workspace_id","created_at");