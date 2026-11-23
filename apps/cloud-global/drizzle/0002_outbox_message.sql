CREATE TABLE "outbox_message" (
	"organization_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"region" text NOT NULL,
	"change_type" text NOT NULL,
	"person_id" text,
	"role" text,
	"created_at" timestamp NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp,
	"last_error" text,
	"next_attempt_at" timestamp,
	"delivered_at" timestamp,
	CONSTRAINT "outbox_message_organization_id_sequence_pk" PRIMARY KEY("organization_id","sequence"),
	CONSTRAINT "outbox_message_region_check" CHECK ("outbox_message"."region" in ('eu', 'us')),
	CONSTRAINT "outbox_message_change_check" CHECK (("outbox_message"."change_type" = 'workspace.created' and "outbox_message"."sequence" = 1 and "outbox_message"."person_id" is null and "outbox_message"."role" is null)
        or ("outbox_message"."change_type" in ('member.added', 'member.role-changed') and "outbox_message"."sequence" > 1 and "outbox_message"."person_id" is not null and "outbox_message"."role" in ('owner', 'admin', 'member'))
        or ("outbox_message"."change_type" = 'member.removed' and "outbox_message"."sequence" > 1 and "outbox_message"."person_id" is not null and "outbox_message"."role" is null))
);
--> statement-breakpoint
CREATE INDEX "outbox_message_undelivered_idx" ON "outbox_message" USING btree ("organization_id","sequence") WHERE "outbox_message"."delivered_at" is null;--> statement-breakpoint
-- Every workspace made before the outbox gets the messages a new one is written with: its
-- `workspace.created` at 1, then one `member.added` per member, in the order they joined, all
-- due at once. A role the contract does not list stops the migration, naming the workspace: a
-- cell learns roles only from here, so none is guessed. Set the row's role, then start again.
DO $$
DECLARE
  unlisted text;
BEGIN
  SELECT o.slug INTO unlisted
    FROM "member" m JOIN "organization" o ON o.id = m.organization_id
    WHERE m.role NOT IN ('owner', 'admin', 'member')
    ORDER BY o.slug
    LIMIT 1;
  IF unlisted IS NOT NULL THEN
    RAISE EXCEPTION 'A member of % has a role the contract does not list. Set it to owner, admin or member, then start again.', unlisted;
  END IF;
END $$;--> statement-breakpoint
INSERT INTO "outbox_message" ("organization_id", "sequence", "region", "change_type", "created_at")
  SELECT "id", 1, "region", 'workspace.created', timezone('utc', now()) FROM "organization";--> statement-breakpoint
-- A person in a workspace twice is added once, as they first joined.
INSERT INTO "outbox_message" ("organization_id", "sequence", "region", "change_type", "person_id", "role", "created_at")
  SELECT m.organization_id,
         1 + row_number() OVER (PARTITION BY m.organization_id ORDER BY m.created_at, m.id),
         o.region, 'member.added', m.user_id, m.role, timezone('utc', now())
    FROM (
      SELECT DISTINCT ON (organization_id, user_id) * FROM "member"
        ORDER BY organization_id, user_id, created_at, id
    ) m
    JOIN "organization" o ON o.id = m.organization_id;