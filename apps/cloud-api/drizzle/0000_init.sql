CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	"region" text NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_session" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"person_id" text,
	"repository" text NOT NULL,
	"harness" text NOT NULL,
	"status" text NOT NULL,
	"title" text,
	"host_url" text,
	"error" text,
	"error_code" text,
	"runner_id" text,
	"created_at" bigint NOT NULL,
	"ended_at" bigint,
	"origin" text,
	"agent_run" text
);
--> statement-breakpoint
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
	"conversation_session_id" text,
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
	CONSTRAINT "run_parent_check" CHECK (("run"."parent_run_id" is null) = ("run"."parent_move" is null) and ("run"."parent_run_id" is null or "run"."kind" = 'automation')),
	CONSTRAINT "run_conversation_check" CHECK ("run"."conversation_session_id" is null or "run"."kind" = 'request')
);
--> statement-breakpoint
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
CREATE TABLE "github_installation" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"connected_by" text NOT NULL,
	"connected_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_token_mint" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "github_token_mint_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"purpose" text NOT NULL,
	"repository_ids" jsonb NOT NULL,
	"permissions" jsonb NOT NULL,
	"minted_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "github_token_mint_purpose_check" CHECK ("github_token_mint"."purpose" in ('review-run', 'factory-pull', 'factory-save')),
	CONSTRAINT "github_token_mint_repositories_check" CHECK (jsonb_typeof("github_token_mint"."repository_ids") = 'array' and jsonb_array_length("github_token_mint"."repository_ids") > 0),
	CONSTRAINT "github_token_mint_permissions_check" CHECK (jsonb_typeof("github_token_mint"."permissions") = 'object')
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory" ADD CONSTRAINT "factory_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_file" ADD CONSTRAINT "factory_file_version_fk" FOREIGN KEY ("workspace_id","factory_id","version") REFERENCES "public"."factory_version"("workspace_id","factory_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factory_version" ADD CONSTRAINT "factory_version_factory_fk" FOREIGN KEY ("workspace_id","factory_id") REFERENCES "public"."factory"("workspace_id","factory_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_approval" ADD CONSTRAINT "run_approval_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."run"("workspace_id","run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_factory_version_fk" FOREIGN KEY ("workspace_id","factory_id","factory_version") REFERENCES "public"."factory_version"("workspace_id","factory_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_parent_fk" FOREIGN KEY ("workspace_id","factory_id","parent_run_id") REFERENCES "public"."run"("workspace_id","factory_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "cloud_session_owner" ON "cloud_session" USING btree ("workspace_id","person_id","created_at");--> statement-breakpoint
CREATE INDEX "cloud_session_workspace" ON "cloud_session" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "factory_name_unique" ON "factory" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "run_list_idx" ON "run" USING btree ("workspace_id","created_at" DESC NULLS LAST,"run_id" DESC NULLS LAST) WHERE "run"."parent_run_id" is null;--> statement-breakpoint
CREATE INDEX "run_children_idx" ON "run" USING btree ("workspace_id","parent_run_id","parent_move") WHERE "run"."parent_run_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "team_name_unique" ON "team" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "team_first_unique" ON "team" USING btree ("workspace_id") WHERE "team"."is_first";--> statement-breakpoint
CREATE INDEX "github_event_received_idx" ON "github_event" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE INDEX "github_installation_workspace_idx" ON "github_installation" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "github_token_mint_workspace_idx" ON "github_token_mint" USING btree ("workspace_id","minted_at");