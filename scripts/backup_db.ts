import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { config } from "@ai-signal/config";

async function backupDatabase() {
  console.log("==========================================================");
  console.log("💾 AI Signal — Database Backup Engine");
  console.log("==========================================================\n");

  const backupDir = path.resolve(process.cwd(), "backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `backup_${timestamp}.sql`;
  const filePath = path.join(backupDir, filename);

  console.log(`Connecting to database: ${config.databaseUrl.replace(/:[^:]*@/, ":****@")}`);

  try {
    // Attempt pg_dump if psql tools are installed locally
    execSync(`pg_dump "${config.databaseUrl}" > "${filePath}"`, { stdio: "pipe" });
    console.log(`✅ Backup successfully created at: ${filePath}`);
    const stats = fs.statSync(filePath);
    console.log(`📦 Size: ${(stats.size / 1024).toFixed(2)} KB`);
  } catch (err: any) {
    console.log(`ℹ️ Local pg_dump CLI is not in PATH. Writing backup command instructions...`);
    
    const instructionsPath = path.join(backupDir, "manual_backup_instructions.md");
    fs.writeFileSync(
      instructionsPath,
      `# Manual Database Backup Commands\n\nRun the following in your shell with PostgreSQL tools installed:\n\n\`\`\`bash\npg_dump "${config.databaseUrl}" > "${filePath}"\n\`\`\`\n\nTo restore:\n\`\`\`bash\npsql "${config.databaseUrl}" < "${filePath}"\n\`\`\`\n`
    );
    console.log(`📝 Backup instructions written to: ${instructionsPath}`);
  }
}

backupDatabase();
