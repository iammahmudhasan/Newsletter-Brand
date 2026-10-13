import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";
import { config } from "@ai-signal/config";

let client: postgres.Sql | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!dbInstance) {
    const connectionString = config.databaseUrl;
    client = postgres(connectionString, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: process.env.NODE_ENV === "test" && !process.env.CI ? 1 : 10,
      prepare: false, // Required for transaction poolers like Supabase & PgBouncer
    });
    dbInstance = drizzle(client, { schema });
  }
  return dbInstance;
}

export const db = getDb();
