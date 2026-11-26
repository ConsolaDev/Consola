CREATE TABLE "run" (
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"factory_id" text NOT NULL,
	"factory_version" integer NOT NULL,
	"parent_run_id" text,
	"parent_move" integer,
	"kind" text NOT NULL,
	"automation" text,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"waiting_on" text,
	"phase" text NOT NULL,
	"trigger" text NOT NULL,
	"trigger_detail" text,
	"started_by_person_id" text,
	"item" jsonb,
	"runner" text NOT NULL,
	"steps" jsonb NOT NULL,
	"request" jsonb,
	"request_text" text,
	"summary" text,
	"error" text,
	"cost_usd" double precision,
	"created_at" timestamp (3) with time zone NOT NULL,
	"started_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "run_workspace_id_run_id_pk" PRIMARY KEY("workspace_id","run_id"),
	CONSTRAINT "run_factory_run_unique" UNIQUE("workspace_id","factory_id","run_id"),
	CONSTRAINT "run_kind_check" CHECK ("run"."kind" in ('request', 'automation')),
	CONSTRAINT "run_status_check" CHECK ("run"."status" in ('queued', 'running', 'needs-approval', 'completed', 'failed', 'rejected', 'waiting', 'expired', 'cancelled')),
	CONSTRAINT "run_phase_check" CHECK ("run"."phase" in ('active', 'needs-you', 'completed', 'failed', 'stopped')),
	CONSTRAINT "run_trigger_check" CHECK ("run"."trigger" in ('cron', 'event', 'poll', 'manual')),
	CONSTRAINT "run_waiting_on_check" CHECK (("run"."status" = 'waiting') = ("run"."waiting_on" is not null) and ("run"."waiting_on" is null or "run"."waiting_on" in ('run', 'person'))),
	CONSTRAINT "run_request_check" CHECK (("run"."kind" = 'request') = ("run"."automation" is null) and ("run"."kind" = 'request') = ("run"."request" is not null) and ("run"."kind" = 'request') = ("run"."request_text" is not null)),
	CONSTRAINT "run_parent_check" CHECK (("run"."parent_run_id" is null) = ("run"."parent_move" is null) and ("run"."parent_run_id" is null or "run"."kind" = 'automation'))
);
--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_workspace_id_workspace_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_factory_version_fk" FOREIGN KEY ("workspace_id","factory_id","factory_version") REFERENCES "public"."factory_version"("workspace_id","factory_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_parent_fk" FOREIGN KEY ("workspace_id","factory_id","parent_run_id") REFERENCES "public"."run"("workspace_id","factory_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_list_idx" ON "run" USING btree ("workspace_id","created_at" DESC NULLS LAST,"run_id" DESC NULLS LAST) WHERE "run"."parent_run_id" is null;--> statement-breakpoint
CREATE INDEX "run_children_idx" ON "run" USING btree ("workspace_id","parent_run_id","parent_move") WHERE "run"."parent_run_id" is not null;