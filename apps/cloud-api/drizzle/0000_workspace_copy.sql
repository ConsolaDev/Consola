CREATE TABLE "workspace_member" (
	"workspace_id" text NOT NULL,
	"person_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "workspace_member_workspace_id_person_id_pk" PRIMARY KEY("workspace_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"last_applied_sequence" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspace_id_workspace_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("workspace_id") ON DELETE no action ON UPDATE no action;