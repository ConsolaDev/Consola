CREATE TABLE "github_event" (
	"workspace_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"payload" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_event_workspace_id_delivery_id_pk" PRIMARY KEY("workspace_id","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "github_event" ADD CONSTRAINT "github_event_workspace_id_workspace_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_event_received_idx" ON "github_event" USING btree ("workspace_id","received_at");