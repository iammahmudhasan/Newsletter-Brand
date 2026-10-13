# AI Signal — System Architecture & Design Specification

## 1. High-Level Architecture

AI Signal is designed around an **API-driven, provider-independent** architecture. All critical business logic, subscriber relationships, cryptographic consent logs, campaign scheduling, and telemetry data remain entirely within your own PostgreSQL database. External email providers (Amazon SES or Resend) are treated strictly as commodity delivery conduits.

```
+---------------------------------------------------------------------------------------+
|                                    CLIENT TIER                                        |
|  - Web Portal (Next.js 15 App Router: Landing Page, /archive, /subscribe, /admin)     |
|  - Mail Clients (Gmail, Apple Mail, Outlook - RFC 8058 One-Click Header Support)      |
+-------------------------------------------+-------------------------------------------+
                                            |
                                            v
+---------------------------------------------------------------------------------------+
|                                 APPLICATION TIER                                      |
|  - Next.js Route Handlers:                                                            |
|      * POST /api/subscribe (Normalization, Rate Limiting, Consent Audit)              |
|      * GET  /confirm (Cryptographic Token Verification, State Transition)             |
|      * POST /api/unsubscribe (1-Click Unsubscribe, Suppression Placement)             |
|      * POST /api/webhooks/email (Idempotent Bounce & Complaint Suppression)           |
|      * POST /api/admin/campaigns (Issue Composition & Queue Scheduling)               |
|                                                                                       |
|  - Background Worker Process (@ai-signal/worker):                                     |
|      * Queue Poller (Atomic PostgreSQL `FOR UPDATE SKIP LOCKED`)                      |
|      * Campaign Scheduler (30-second interval poll for scheduled releases)            |
|      * Batch Delivery Engine (Sequential throttling, suppression checks)              |
|      * Retries with Exponential Backoff                                               |
+-------------------------------------------+-------------------------------------------+
                                            |
                                            v
+---------------------------------------------------------------------------------------+
|                                    DATA TIER                                          |
|  - PostgreSQL Database (Drizzle ORM)                                                  |
|      * subscribers           * consent_events         * campaigns                     |
|      * campaign_recipients   * email_events           * suppressions                  |
|      * automation_jobs       * admin_users                                            |
+-------------------------------------------+-------------------------------------------+
                                            |
                                            v
+---------------------------------------------------------------------------------------+
|                            EMAIL DELIVERY ABSTRACTION                                 |
|  - @ai-signal/email                                                                   |
|      * ConsoleMockEmailProvider (Local offline dev: saves to .local_emails/)          |
|      * ResendEmailProvider (Transactional & broadcast REST API)                       |
|      * SesEmailProvider (High-volume AWS SES v2 API)                                  |
+---------------------------------------------------------------------------------------+
```

---

## 2. Security & Compliance Design

### Double Opt-In (HMAC-SHA256 Signed Tokens)
* Tokens are signed using `crypto.createHmac("sha256", AUTH_SECRET)`.
* Format: `<base64url_json_payload>.<base64url_signature>`.
* Includes a 72-hour expiration timestamp (`exp`).
* Prevents spoofed activation and tampering.

### Privacy-Preserving Consent Logging
* When users opt in, their IP address is hashed using SHA-256 with a salt (`hashIp(ip)`).
* The raw IP is never stored in plain text, satisfying modern data privacy standards while preserving an immutable cryptographic audit record.

### Suppression Enforcement
* Before any email is dispatched, the worker queries the `suppressions` table.
* Any address that previously hard-bounced, lodged a spam complaint, or manually unsubscribed is excluded from the campaign batch snapshot.
