CREATE TABLE "admin_login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_hash" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"locked_until" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_login_ip_hash_idx" ON "admin_login_attempts" USING btree ("ip_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "email_events_msg_type_idx" ON "email_events" USING btree ("provider_message_id","event_type");