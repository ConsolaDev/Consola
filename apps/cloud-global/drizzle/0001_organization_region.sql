-- Every workspace has a region. Organisations made before regions existed are in eu
-- (DEPLOYMENT_REGION), and the column is required once they have one.
ALTER TABLE "organization" ADD COLUMN "region" text;--> statement-breakpoint
UPDATE "organization" SET "region" = 'eu' WHERE "region" IS NULL;--> statement-breakpoint
ALTER TABLE "organization" ALTER COLUMN "region" SET NOT NULL;
