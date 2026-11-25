ALTER TABLE "github_event" ADD COLUMN "repository_id" bigint;--> statement-breakpoint
ALTER TABLE "github_event" ADD COLUMN "repository" text;--> statement-breakpoint
ALTER TABLE "github_event" ADD COLUMN "runner_state" text;--> statement-breakpoint
ALTER TABLE "github_event" ADD COLUMN "runner_facts" jsonb;--> statement-breakpoint
CREATE INDEX "github_event_held_idx" ON "github_event" USING btree ("workspace_id","received_at") WHERE "github_event"."runner_state" = 'held';--> statement-breakpoint
ALTER TABLE "github_event" ADD CONSTRAINT "github_event_repository_check" CHECK (("github_event"."repository_id" is null) = ("github_event"."repository" is null));--> statement-breakpoint
ALTER TABLE "github_event" ADD CONSTRAINT "github_event_runner_check" CHECK (("github_event"."runner_state" is null or "github_event"."runner_state" in ('held', 'acknowledged', 'not-for-runners')) and ("github_event"."runner_state" is not null and "github_event"."runner_state" <> 'not-for-runners') = ("github_event"."runner_facts" is not null));