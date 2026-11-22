CREATE TABLE "github_token_mint" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "github_token_mint_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" text NOT NULL,
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
CREATE INDEX "github_token_mint_organization_idx" ON "github_token_mint" USING btree ("organization_id","minted_at");