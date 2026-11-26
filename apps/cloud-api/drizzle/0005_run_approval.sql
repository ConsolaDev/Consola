CREATE TABLE "run_approval" (
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"version" integer NOT NULL,
	"decision" text NOT NULL,
	"person_id" text NOT NULL,
	"answered_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_approval_workspace_id_run_id_version_pk" PRIMARY KEY("workspace_id","run_id","version"),
	CONSTRAINT "run_approval_decision_check" CHECK ("run_approval"."decision" in ('approved', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "run_approval" ADD CONSTRAINT "run_approval_workspace_id_workspace_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_approval" ADD CONSTRAINT "run_approval_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."run"("workspace_id","run_id") ON DELETE cascade ON UPDATE no action;