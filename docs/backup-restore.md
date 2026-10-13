# Database Backup & Disaster Recovery Guide

## 1. Managed Cloud Backups

### Supabase
* **Daily Backups:** Handled automatically in the Supabase Pro plan ($25/mo) with 7 days of daily snapshots.
* **Point-in-Time Recovery (PITR):** Enables restoration to any second within the retention window.

### Neon
* **Branching Snapshots:** Neon supports instantaneous copy-on-write branching for zero-downtime test restores.

---

## 2. Command-Line Backups (pg_dump)

### Taking a Full Snapshot
```bash
# Export schema + data to compressed SQL file
pg_dump "$DATABASE_URL" -Fc > backups/ai_signal_$(date +%Y%m%d_%H%M%S).dump
```

### Restoring from a Snapshot
```bash
# Restore to database
pg_restore -d "$DATABASE_URL" --clean --if-exists backups/ai_signal_20261014.dump
```

---

## 3. Disaster Recovery Test Protocol
1. Provision a temporary staging database instance.
2. Restore the latest backup dump using `pg_restore`.
3. Run the verification test suite:
   ```bash
   bun run test
   ```
4. Verify record counts for `subscribers`, `campaigns`, and `suppressions`:
   ```sql
   SELECT count(*) FROM subscribers;
   SELECT count(*) FROM suppressions;
   ```
