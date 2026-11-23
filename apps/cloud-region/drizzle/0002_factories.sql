CREATE TABLE "factory" (
	"factory_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text DEFAULT 'stored' NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factory_workspace_id_factory_id_unique" UNIQUE("workspace_id","factory_id")
);
--> statement-breakpoint
CREATE TABLE "factory_file" (
	"workspace_id" text NOT NULL,
	"factory_id" text NOT NULL,
	"version" integer NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "factory_file_workspace_id_factory_id_version_path_pk" PRIMARY KEY("workspace_id","factory_id","version","path")
);
--> statement-breakpoint
CREATE TABLE "factory_version" (
	"workspace_id" text NOT NULL,
	"factory_id" text NOT NULL,
	"version" integer NOT NULL,
	"saved_by_person_id" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factory_version_workspace_id_factory_id_version_pk" PRIMARY KEY("workspace_id","factory_id","version")
);
--> statement-breakpoint
ALTER TABLE "factory" ADD CONSTRAINT "factory_workspace_id_workspace_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory" ADD CONSTRAINT "factory_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_file" ADD CONSTRAINT "factory_file_version_fk" FOREIGN KEY ("workspace_id","factory_id","version") REFERENCES "public"."factory_version"("workspace_id","factory_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_version" ADD CONSTRAINT "factory_version_factory_fk" FOREIGN KEY ("workspace_id","factory_id") REFERENCES "public"."factory"("workspace_id","factory_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "factory_name_unique" ON "factory" USING btree ("workspace_id",lower("name"));