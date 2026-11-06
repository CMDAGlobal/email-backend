import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from './database';
export async function migrate() {
 const db = new Database();
 try {
  await db.transaction(async client => {
   await client.query('SELECT pg_advisory_xact_lock(4182601)');
   await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
   const folder = resolve(__dirname, '../../migrations');
   for (const name of (await readdir(folder)).filter(n => n.endsWith('.sql')).sort()) {
    if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1',[name])).rowCount) continue;
    await client.query(await readFile(resolve(folder,name),'utf8'));
    await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);
    console.log(`Applied ${name}`);
   }
  });
 } finally { await db.onModuleDestroy(); }
}
// Run only when invoked directly (tsx src/db/migrate.ts / node dist/db/migrate.js),
// not when imported by main.ts for RUN_MIGRATIONS_ON_BOOT.
if (process.argv[1]?.includes('migrate')) migrate().catch(error => { console.error(error); process.exitCode=1; });
