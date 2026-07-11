// CLI migration runner for production: npm run migrate
import pg from "pg";
import { loadConfig } from "./config.js";
import { migrate } from "./migrations.js";

const config = loadConfig();
if (!config.databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
await migrate(pool);
console.log("migrations applied");
await pool.end();
