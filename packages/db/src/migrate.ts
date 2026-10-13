import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const defaultConnectionString =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/ai_signal";

export async function runMigrations(customConnectionString?: string) {
  const connStr = customConnectionString || defaultConnectionString;
  console.log("[Database Migration] Connecting to database to apply versioned migrations...");
  const sql = postgres(connStr, { max: 1 });
  const db = drizzle(sql);

  const migrationsFolder = path.resolve(__dirname, "../migrations");
  console.log(`[Database Migration] Applying committed migrations from ${migrationsFolder}...`);

  try {
    await migrate(db, { migrationsFolder });
    console.log("[Database Migration] All versioned SQL migrations applied successfully!");
  } catch (err: any) {
    console.error("[Database Migration] Failed to apply migrations:", err.message);
    throw err;
  } finally {
    await sql.end();
  }
}

// Execute if run directly from CLI
if (typeof process !== "undefined" && process.argv[1] && (process.argv[1].endsWith("migrate.ts") || process.argv[1].endsWith("migrate.js"))) {
  runMigrations().catch((err) => {
    console.error("[Database Migration Error]:", err);
    process.exit(1);
  });
}
