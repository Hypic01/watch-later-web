import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../server/migrations.js";
import { createDb } from "../server/db.js";

// Real Postgres (WASM) per test file — same SQL surface as Supabase in prod.
export async function testDb() {
  const pg = new PGlite();
  await migrate(pg);
  return { db: createDb(pg), pg };
}

export const U1 = "11111111-1111-4111-a111-111111111111";
export const U2 = "22222222-2222-4222-a222-222222222222";

export async function seedUser(db, id = U1, email = "u1@test.dev") {
  return db.upsertUser({ id, email });
}

export function vids(n, prefix = "v") {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${String(i).padStart(8, "0")}`,
    title: `Video ${prefix}${i}`,
    channel: `Channel ${i % 7}`,
    durationSeconds: 60 + i,
    position: i + 1,
    publishedText: `${(i % 9) + 1} months ago`,
  }));
}
