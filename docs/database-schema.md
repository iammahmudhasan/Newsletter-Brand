# PostgreSQL Database Schema Specification

This document details the 8 core tables managed by **Drizzle ORM** in `@ai-signal/db`.

---

## 1. `subscribers`
Manages reader profiles and lifecycle states.

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `uuid` | Primary Key, `defaultRandom()` | Unique subscriber ID |
| `email` | `text` | Unique Index, Not Null | Lowercased, normalized email address |
| `status` | `text` | Enum, Not Null | `pending_confirmation`, `active`, `unsubscribed`, `bounced`, `complained` |
| `signup_source` | `text` | Default `'web_form'` | Registration origin (e.g., `hero_main`, `archive`) |
| `confirmation_token` | `text` | Nullable | Last issued HMAC confirmation token |
| `confirmation_token_expires_at` | `timestamp` | Nullable | Token expiry timestamp |
| `unsubscribe_token` | `text` | Nullable | Dedicated unsubscribe token |
| `preferences` | `jsonb` | Default `{}` | Topic preference flags |
| `confirmed_at` | `timestamp` | Nullable | Timestamp of double opt-in confirmation |
| `created_at` | `timestamp` | Default `NOW()` | Registration timestamp |
| `updated_at` | `timestamp` | Default `NOW()` | Last record modification |

---

## 2. `consent_events`
Stores immutable consent audit events for GDPR / CAN-SPAM compliance.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `uuid` | Primary Key |
| `subscriber_id` | `uuid` | Foreign key referencing `subscribers.id` |
| `source` | `text` | Form location or API source |
| `consent_text` | `text` | Legal consent disclosure displayed to user |
| `ip_hash` | `text` | SHA-256 salted hash of client IP |
| `user_agent` | `text` | Client User-Agent string |
| `created_at` | `timestamp` | Audit event timestamp |

---

## 3. `campaigns`
Stores weekly newsletter issues.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `uuid` | Primary Key |
| `title` | `text` | Internal issue title |
| `subject` | `text` | Email subject line |
| `preview_text` | `text` | Preheader snippet |
| `content_markdown` | `text` | Raw Markdown content |
| `content_html` | `text` | Rendered HTML email content |
| `content_plain` | `text` | Plain text fallback |
| `status` | `text` | `draft`, `scheduled`, `sending`, `sent`, `cancelled` |
| `scheduled_at` | `timestamp` | Dispatch target time |
| `sent_at` | `timestamp` | Delivery completion time |
| `total_recipients` | `integer` | Count of eligible recipients |
| `successful_sends` | `integer` | Count of accepted deliveries |
| `failed_sends` | `integer` | Count of transmission failures |

---

## 4. `campaign_recipients`
Tracks individual transmission outcome for every recipient per campaign.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `uuid` | Primary Key |
| `campaign_id` | `uuid` | Reference to `campaigns.id` |
| `subscriber_id` | `uuid` | Reference to `subscribers.id` |
| `status` | `text` | `queued`, `sent`, `failed`, `bounced` |
| `provider_message_id` | `text` | Message ID returned by SES / Resend |
| `error_message` | `text` | Delivery failure diagnostics |
| `sent_at` | `timestamp` | Dispatch timestamp |

---

## 5. `email_events`
Ingests provider webhook callbacks (bounces, complaints, clicks).

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `uuid` | Primary Key |
| `provider_message_id` | `text` | Provider correlation ID |
| `recipient_email` | `text` | Affected email address |
| `event_type` | `text` | `delivered`, `bounce`, `complaint`, `click`, `open` |
| `payload` | `jsonb` | Complete webhook JSON payload |
| `created_at` | `timestamp` | Webhook receipt timestamp |

---

## 6. `suppressions`
Global suppression list preventing future dispatches.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `uuid` | Primary Key |
| `email` | `text` | Unique suppressed address |
| `reason` | `text` | `hard_bounce`, `complaint`, `manual_unsubscribe`, `admin_block` |
| `details` | `text` | Contextual diagnostic string |
| `created_at` | `timestamp` | Date suppressed |

---

## 7. `automation_jobs`
Durable queue table powered by `FOR UPDATE SKIP LOCKED`.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `uuid` | Primary Key |
| `job_name` | `text` | Job handler name |
| `payload` | `jsonb` | Structured job arguments |
| `status` | `text` | `pending`, `processing`, `completed`, `failed` |
| `retry_count` | `integer` | Current retry counter |
| `max_retries` | `integer` | Maximum retry limit (default 3) |
| `last_error` | `text` | Error message on failure |
| `scheduled_for` | `timestamp` | Execution threshold |
| `locked_at` | `timestamp` | Worker claim lock timestamp |
| `completed_at` | `timestamp` | Completion timestamp |

---

## 8. `admin_users`
Admin dashboard credentials.

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `uuid` | Primary Key |
| `email` | `text` | Unique admin email |
| `password_hash` | `text` | Argon2 / bcrypt password hash |
| `name` | `text` | Admin display name |
| `role` | `text` | Access role (`admin`, `editor`) |
| `created_at` | `timestamp` | Creation timestamp |
