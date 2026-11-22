CREATE TABLE "team_member" (
	"workspace_id" text NOT NULL,
	"team_id" text NOT NULL,
	"person_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_member_team_id_person_id_pk" PRIMARY KEY("team_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "team" (
	"team_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"is_first" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_workspace_id_team_id_unique" UNIQUE("workspace_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_workspace_member_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."workspace_member"("workspace_id","person_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_workspace_id_workspace_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_name_unique" ON "team" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "team_first_unique" ON "team" USING btree ("workspace_id") WHERE "team"."is_first";--> statement-breakpoint
-- Written by hand: a workspace the cell held before it had teams gets its first team (FIRST_TEAM_NAME), holding every member it has.
INSERT INTO "team" ("workspace_id", "name", "is_first") SELECT "workspace_id", 'General', true FROM "workspace";--> statement-breakpoint
INSERT INTO "team_member" ("workspace_id", "team_id", "person_id") SELECT m."workspace_id", t."team_id", m."person_id" FROM "workspace_member" m JOIN "team" t ON t."workspace_id" = m."workspace_id" AND t."is_first";