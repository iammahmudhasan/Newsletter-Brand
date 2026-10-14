ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "claim_token" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "issue_number" integer;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_idempotency_key_idx" ON "campaigns" USING btree ("idempotency_key");
