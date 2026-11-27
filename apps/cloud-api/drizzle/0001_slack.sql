CREATE TABLE "slack_app" (
	"workspace_id" text NOT NULL,
	"factory_id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"signing_secret" text NOT NULL,
	"handle" text NOT NULL,
	"configured_by" text NOT NULL,
	"configured_at" timestamp (3) with time zone NOT NULL,
	"app_id" text,
	"team_id" text,
	"team_name" text,
	"bot_user_id" text,
	"bot_token" text,
	"installed_by" text,
	"installed_at" timestamp (3) with time zone,
	"needs_reinstall" boolean DEFAULT false NOT NULL,
	CONSTRAINT "slack_app_install_check" CHECK (("slack_app"."app_id" is null) = ("slack_app"."bot_token" is null) and ("slack_app"."app_id" is null) = ("slack_app"."team_id" is null) and ("slack_app"."app_id" is null) = ("slack_app"."team_name" is null) and ("slack_app"."app_id" is null) = ("slack_app"."bot_user_id" is null) and ("slack_app"."app_id" is null) = ("slack_app"."installed_by" is null) and ("slack_app"."app_id" is null) = ("slack_app"."installed_at" is null)),
	CONSTRAINT "slack_app_reinstall_check" CHECK (not "slack_app"."needs_reinstall" or "slack_app"."app_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "slack_event" (
	"workspace_id" text NOT NULL,
	"factory_id" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_event_factory_id_event_id_pk" PRIMARY KEY("factory_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "slack_link_request" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"factory_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "slack_person_link" (
	"link_id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"workspace_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"person_id" text NOT NULL,
	"linked_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "slack_person_link_user_unique" UNIQUE("workspace_id","slack_team_id","slack_user_id")
);
--> statement-breakpoint
CREATE TABLE "slack_request" (
	"workspace_id" text NOT NULL,
	"session_id" text PRIMARY KEY NOT NULL,
	"factory_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"message_ts" text NOT NULL,
	"started_by" text NOT NULL,
	"posted" text,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_app" ADD CONSTRAINT "slack_app_factory_fk" FOREIGN KEY ("workspace_id","factory_id") REFERENCES "public"."factory"("workspace_id","factory_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_event" ADD CONSTRAINT "slack_event_factory_fk" FOREIGN KEY ("workspace_id","factory_id") REFERENCES "public"."factory"("workspace_id","factory_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_link_request" ADD CONSTRAINT "slack_link_request_factory_fk" FOREIGN KEY ("workspace_id","factory_id") REFERENCES "public"."factory"("workspace_id","factory_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_request" ADD CONSTRAINT "slack_request_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cloud_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_request" ADD CONSTRAINT "slack_request_factory_fk" FOREIGN KEY ("workspace_id","factory_id") REFERENCES "public"."factory"("workspace_id","factory_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_app_workspace_idx" ON "slack_app" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_app_app_unique" ON "slack_app" USING btree ("app_id") WHERE "slack_app"."app_id" is not null;--> statement-breakpoint
CREATE INDEX "slack_event_received_idx" ON "slack_event" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE INDEX "slack_link_request_factory_idx" ON "slack_link_request" USING btree ("workspace_id","factory_id");--> statement-breakpoint
CREATE INDEX "slack_person_link_person_idx" ON "slack_person_link" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE INDEX "slack_request_thread_idx" ON "slack_request" USING btree ("factory_id","channel_id","thread_ts");