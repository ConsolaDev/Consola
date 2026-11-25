-- Written by hand, before the check drizzle-kit wrote: an item recorded before it held its head
-- commit and base branch holds them as null, which every item may.
UPDATE "run" SET "item" = "item" || '{"headSha": null, "baseRef": null}'::jsonb WHERE "item" IS NOT NULL AND "item"->'headSha' IS NULL;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_item_head_check" CHECK ("run"."item" is null or ("run"."item"->'headSha' is not null and "run"."item"->'baseRef' is not null and ("run"."item"->>'kind' = 'pr' or (jsonb_typeof("run"."item"->'headSha') = 'null' and jsonb_typeof("run"."item"->'baseRef') = 'null'))));
