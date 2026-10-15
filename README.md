# AI Signal — Production Newsletter Platform & Media Brand

> **Frontier AI Research & Startup Intelligence**  
> A provider-independent, custom-coded newsletter platform built with **Next.js 15**, **TypeScript**, **PostgreSQL**, **Drizzle ORM**, and a durable background worker queue.

---

## 🏗️ Architecture Overview

```
                                  +-----------------------+
                                  |     Reader / User     |
                                  +-----------+-----------+
                                              |
                     +------------------------+------------------------+
                     |                                                 |
            (Browses & Subscribes)                               (1-Click Unsub)
                     v                                                 v
           +--------------------+                            +--------------------+
           |  Next.js Frontend  |                            |   /unsubscribe     |
           |    (App Router)    |                            +---------+----------+
           +---------+----------+                                      |
                     |                                                 |
             (POST /api/subscribe)                                     |
                     v                                                 |
        +----------------------------+                                 |
        |  PostgreSQL Database (DB)  |<--------------------------------+
        |   - subscribers            |   (Updates status to unsubscribed)
        |   - consent_events         |   (Records suppression rule)
        |   - campaigns              |
        |   - campaign_recipients    |
        |   - suppressions           |
        |   - automation_jobs        |
        +-------------+--------------+
                      |
                (Enqueues Job)
                      v
        +----------------------------+
        |     Background Worker      |
        |  (Polls automation_jobs)   |
        |  (FOR UPDATE SKIP LOCKED)  |
        +-------------+--------------+
                      |
           (Provider Abstraction)
         +------------+------------+
         |            |            |
         v            v            v
     [Console]     [Resend]      [SES]
    (Local Dev)
```

---

## ⚡ Quickstart

### 1. Install Dependencies
```bash
# Using bun (recommended)
bun install

# Or using npm
npm install
```

### 2. Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Key environment variables:
* `DATABASE_URL`: Your PostgreSQL connection string (Supabase, Neon, or local PostgreSQL).
* `EMAIL_PROVIDER`: Set to `console` for local zero-config offline testing. Emails will be logged to the terminal and saved to `.local_emails/*.html`!
* `AUTH_SECRET`: Secret key used for signing tamper-proof HMAC confirmation and unsubscribe tokens.

### 3. Launch Development Services
Run the web application:
```bash
bun run dev
# or: npm run dev
```
Open [http://localhost:3000](http://localhost:3000) to view the landing page.

Run the background worker (in a separate terminal):
```bash
bun run worker
# or: npm run worker
```

---

## 📦 Monorepo Structure

```
├── apps/
│   ├── web/               # Next.js App Router (Landing page, archive, admin, API routes)
│   └── worker/            # Background worker (batch sending, queue polling, retry logic)
├── packages/
│   ├── config/            # Shared configuration, env validation, HMAC token signing
│   ├── db/                # Drizzle ORM schema (8 tables), indexes, PostgreSQL client
│   ├── email/             # Provider-agnostic engine (Console mock, Resend, SES, templates)
│   └── queue/             # Durable job queue with PostgreSQL FOR UPDATE SKIP LOCKED
├── content/
│   └── issues/            # Production-ready newsletter issues (Markdown format)
│       ├── issue-01.md    # Frontier Reasoning & Test-Time Compute
│       ├── issue-02.md    # Production Agents & Context Caching
│       └── issue-03.md    # Open Weights Economics vs API Tokens
├── .env.example           # Environment template
└── package.json           # Monorepo workspaces definition
```

---

## 🛡️ Production Security & Deliverability Features

1. **Strict Double Opt-In**:
   Subscribers start in `pending_confirmation`. A cryptographically signed token is dispatched with a 72-hour expiration window.
2. **RFC 8058 One-Click Unsubscribe**:
   All emails include `List-Unsubscribe` and `List-Unsubscribe-Post` headers for Gmail & Yahoo inbox compliance.
3. **Idempotent Webhooks & Suppressions**:
   Incoming bounce and spam complaint events automatically transition the subscriber to `bounced` or `complained` and register them in the `suppressions` table, permanently preventing future dispatches.
4. **Durable Job Queue**:
   Jobs use row-level locking (`FOR UPDATE SKIP LOCKED`) directly in PostgreSQL. If the server restarts, pending jobs are never lost.
5. **Zero-Lockin Provider Abstraction**:
   Switch between `console`, `resend`, and `ses` with a single environment variable change without modifying any business logic.
6. **Hardened Proxy Resolution & Bounded Streaming Limits**:
   Rate-limiting defends against `X-Forwarded-For` spoofing by requiring explicit proxy allowlists (`TRUSTED_PROXIES`) and defaulting to fail-closed against unverified private IP hops in production. Public endpoints (`/api/subscribe`, `/api/subscriber/gdpr/*`) enforce true incremental byte stream limits (16 KB max) to prevent memory exhaustion.

---

## 📰 Editorial Issues Included
The first three issues of **AI Signal** are drafted and ready to publish in `content/issues/`:
* **Issue #01**: [Frontier Reasoning, Test-Time Compute & Synthetic Data Loops](content/issues/issue-01.md)
* **Issue #02**: [Context Caching Economics & Grammar-Constrained Decoding](content/issues/issue-02.md)
* **Issue #03**: [Open-Weights Economics vs Proprietary API Tokens](content/issues/issue-03.md)

---

## 📜 License
Private & Proprietary © 2026 AI Signal Media.
