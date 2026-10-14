DROP INDEX IF EXISTS "email_events_msg_type_idx";--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "provider_event_id" text;--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "recipient_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_events" ADD CONSTRAINT "email_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_events" ADD CONSTRAINT "email_events_recipient_id_campaign_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."campaign_recipients"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DELETE FROM email_events
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY provider_event_id ORDER BY created_at DESC) as rnum
    FROM email_events
    WHERE provider_event_id IS NOT NULL
  ) t
  WHERE t.rnum > 1
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipient_campaign_status_idx" ON "campaign_recipients" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_events_provider_event_idx" ON "email_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_events_recipient_id_idx" ON "email_events" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_events_campaign_id_idx" ON "email_events" USING btree ("campaign_id");