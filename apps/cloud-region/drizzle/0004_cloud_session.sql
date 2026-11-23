CREATE TABLE "cloud_session" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"person_id" text NOT NULL,
	"repository" text NOT NULL,
	"harness" text NOT NULL,
	"status" text NOT NULL,
	"title" text,
	"host_url" text,
	"error" text,
	"error_code" text,
	"runner_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"ended_at" bigint
);
--> statement-breakpoint
CREATE INDEX "cloud_session_owner" ON "cloud_session" USING btree ("workspace_id","person_id","created_at");