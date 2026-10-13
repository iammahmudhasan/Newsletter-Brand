import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ----------------------------------------------------
// 1. Subscribers
// ----------------------------------------------------
export const subscribers = pgTable(
  "subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    status: text("status", {
      enum: ["pending_confirmation", "active", "unsubscribed", "bounced", "complained"],
    })
      .notNull()
      .default("pending_confirmation"),
    signupSource: text("signup_source").default("web_form"),
    confirmationToken: text("confirmation_token"),
    confirmationTokenExpiresAt: timestamp("confirmation_token_expires_at"),
    unsubscribeToken: text("unsubscribe_token"),
    preferences: jsonb("preferences").$type<Record<string, boolean>>().default({}),
    confirmedAt: timestamp("confirmed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("subscribers_email_idx").on(table.email),
    index("subscribers_status_idx").on(table.status),
  ]
);

// ----------------------------------------------------
// 2. Consent Events (Audit trail for GDPR, CAN-SPAM)
// ----------------------------------------------------
export const consentEvents = pgTable(
  "consent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("web_form"),
    consentText: text("consent_text").notNull(),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("consent_subscriber_idx").on(table.subscriberId),
  ]
);

// ----------------------------------------------------
// 3. Campaigns (Newsletter issues)
// ----------------------------------------------------
export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    subject: text("subject").notNull(),
    previewText: text("preview_text"),
    contentMarkdown: text("content_markdown"),
    contentHtml: text("content_html").notNull(),
    contentPlain: text("content_plain"),
    status: text("status", {
      enum: ["draft", "scheduled", "sending", "sent", "partially_failed", "failed", "cancelled"],
    })
      .notNull()
      .default("draft"),
    scheduledAt: timestamp("scheduled_at"),
    sentAt: timestamp("sent_at"),
    totalRecipients: integer("total_recipients").default(0),
    successfulSends: integer("successful_sends").default(0),
    failedSends: integer("failed_sends").default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("campaigns_status_idx").on(table.status),
    index("campaigns_scheduled_idx").on(table.scheduledAt),
  ]
);

// ----------------------------------------------------
// 4. Campaign Recipients (Delivery tracking per recipient)
// ----------------------------------------------------
export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["queued", "processing", "sent", "failed", "bounced"],
    })
      .notNull()
      .default("queued"),
    providerMessageId: text("provider_message_id"),
    errorMessage: text("error_message"),
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("campaign_recipient_unique_idx").on(table.campaignId, table.subscriberId),
    index("recipient_campaign_idx").on(table.campaignId),
    index("recipient_provider_msg_idx").on(table.providerMessageId),
  ]
);

// ----------------------------------------------------
// 5. Email Events (Webhook telemetry from SES/Resend)
// ----------------------------------------------------
export const emailEvents = pgTable(
  "email_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerMessageId: text("provider_message_id"),
    recipientEmail: text("recipient_email").notNull(),
    eventType: text("event_type", {
      enum: ["delivered", "bounce", "complaint", "click", "open", "unknown"],
    }).notNull(),
    payload: jsonb("payload").$type<Record<string, any>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("email_events_msg_idx").on(table.providerMessageId),
    index("email_events_recipient_idx").on(table.recipientEmail),
    index("email_events_type_idx").on(table.eventType),
    uniqueIndex("email_events_msg_type_idx").on(table.providerMessageId, table.eventType),
  ]
);

// ----------------------------------------------------
// 6. Suppressions (Hard bounces, spam complaints)
// ----------------------------------------------------
export const suppressions = pgTable(
  "suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    reason: text("reason", {
      enum: ["hard_bounce", "complaint", "manual_unsubscribe", "admin_block"],
    }).notNull(),
    details: text("details"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("suppressions_email_idx").on(table.email),
  ]
);

// ----------------------------------------------------
// 7. Automation Jobs (Persistent DB Queue)
// ----------------------------------------------------
export const automationJobs = pgTable(
  "automation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobName: text("job_name").notNull(),
    payload: jsonb("payload").$type<Record<string, any>>().notNull(),
    status: text("status", {
      enum: ["pending", "processing", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    retryCount: integer("retry_count").default(0),
    maxRetries: integer("max_retries").default(3),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key"),
    scheduledFor: timestamp("scheduled_for").defaultNow(),
    lockedAt: timestamp("locked_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("jobs_status_scheduled_idx").on(table.status, table.scheduledFor),
    uniqueIndex("jobs_idempotency_idx").on(table.idempotencyKey),
  ]
);

// ----------------------------------------------------
// 8. Admin Users
// ----------------------------------------------------
export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").default("Admin"),
    role: text("role").default("admin"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("admin_email_idx").on(table.email),
  ]
);

// ----------------------------------------------------
// 9. Admin Login Rate Limiting (Distributed brute-force defense)
// ----------------------------------------------------
export const adminLoginAttempts = pgTable(
  "admin_login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ipHash: text("ip_hash").notNull(),
    attempts: integer("attempts").notNull().default(1),
    lockedUntil: timestamp("locked_until"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("admin_login_ip_hash_idx").on(table.ipHash),
  ]
);

// ----------------------------------------------------
// Relations
// ----------------------------------------------------
export const subscribersRelations = relations(subscribers, ({ many }) => ({
  consentEvents: many(consentEvents),
  campaignRecipients: many(campaignRecipients),
}));

export const campaignsRelations = relations(campaigns, ({ many }) => ({
  recipients: many(campaignRecipients),
}));

export const campaignRecipientsRelations = relations(campaignRecipients, ({ one }) => ({
  campaign: one(campaigns, {
    fields: [campaignRecipients.campaignId],
    references: [campaigns.id],
  }),
  subscriber: one(subscribers, {
    fields: [campaignRecipients.subscriberId],
    references: [subscribers.id],
  }),
}));
