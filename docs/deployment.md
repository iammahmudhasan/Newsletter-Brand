# Production Deployment Guide

This guide describes how to deploy **AI Signal** across managed cloud services.

---

## 1. PostgreSQL Database Setup

### Option A: Supabase (Recommended)
1. Create a project at [supabase.com](https://supabase.com).
2. Retrieve your Transaction Pooler connection string (URI mode, port 6543) or Direct Connection string (port 5432).
3. Set in `.env`:
   ```bash
   DATABASE_URL="postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres"
   ```
4. Push your schema:
   ```bash
   bun run db:push
   ```

### Option B: Neon Serverless Postgres
1. Create a database on [neon.tech](https://neon.tech).
2. Copy the pooled connection string into `DATABASE_URL`.
3. Run `bun run db:push`.

---

## 2. Web Application Deployment (Next.js)

### Deploying on Vercel
1. Import your GitHub repository: `https://github.com/iammahmudhasan/Newsletter-Brand`.
2. Set root directory to `.` or `apps/web`.
3. Configure Environment Variables in the Vercel dashboard:
   * `DATABASE_URL`: Your production PostgreSQL connection string.
   * `APP_URL`: Your custom production domain (e.g. `https://aisignal.dev`).
   * `AUTH_SECRET`: A 64-character random string (`openssl rand -hex 32`).
   * `EMAIL_PROVIDER`: `resend` or `ses`.
   * `RESEND_API_KEY`: If using Resend.
4. Deploy.

---

## 3. Background Worker Deployment

Deploy the worker as a continuous background daemon (e.g. on Railway, Render, Fly.io, or an AWS ECS container):
```bash
# Start command
bun run worker
# or:
npm run worker
```

The worker requires:
* `DATABASE_URL`
* `APP_URL`
* `AUTH_SECRET`
* `EMAIL_PROVIDER` (`resend` or `ses`)
* `RESEND_API_KEY` (or AWS credentials)

---

## 4. DNS Authentication (SPF, DKIM, DMARC)

To achieve 99%+ deliverability into Gmail & Yahoo Primary inboxes:
1. **SPF Record**: `v=spf1 include:amazonses.com ~all` (or `include:resend.com ~all`).
2. **DKIM**: Add CNAME records provided by AWS SES / Resend.
3. **DMARC**: Add TXT record for `_dmarc.aisignal.dev`:
   ```text
   v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@aisignal.dev; pct=100
   ```
4. **Custom Mail-From Domain**: Set up `mail.aisignal.dev` in your provider console to align SPF with your header From address.
