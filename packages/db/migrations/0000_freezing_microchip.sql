CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text DEFAULT 'Admin',
	"role" text DEFAULT 'admin',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0,
	"max_retries" integer DEFAULT 3,
	"last_error" text,
	"scheduled_for" timestamp DEFAULT now(),
	"locked_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"error_message" text,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"subject" text NOT NULL,
	"preview_text" text,
	"content_markdown" text,
	"content_html" text NOT NULL,
	"content_plain" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp,
	"sent_at" timestamp,
	"total_recipients" integer DEFAULT 0,
	"successful_sends" integer DEFAULT 0,
	"failed_sends" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"source" text DEFAULT 'web_form' NOT NULL,
	"consent_text" text NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_message_id" text,
	"recipient_email" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending_confirmation' NOT NULL,
	"signup_source" text DEFAULT 'web_form',
	"confirmation_token" text,
	"confirmation_token_expires_at" timestamp,
	"unsubscribe_token" text,
	"preferences" jsonb DEFAULT '{}'::jsonb,
	"confirmed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_email_idx" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "jobs_status_scheduled_idx" ON "automation_jobs" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipient_unique_idx" ON "campaign_recipients" USING btree ("campaign_id","subscriber_id");--> statement-breakpoint
CREATE INDEX "recipient_campaign_idx" ON "campaign_recipients" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "recipient_provider_msg_idx" ON "campaign_recipients" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaigns_scheduled_idx" ON "campaigns" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "consent_subscriber_idx" ON "consent_events" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "email_events_msg_idx" ON "email_events" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "email_events_recipient_idx" ON "email_events" USING btree ("recipient_email");--> statement-breakpoint
CREATE INDEX "email_events_type_idx" ON "email_events" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "subscribers_email_idx" ON "subscribers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "subscribers_status_idx" ON "subscribers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_email_idx" ON "suppressions" USING btree ("email");