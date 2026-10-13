ALTER TABLE "automation_jobs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_idx" ON "automation_jobs" USING btree ("idempotency_key");