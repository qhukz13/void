import { loadConfig } from '../config.js';
import { createDatabaseAdapter } from './adapter.js';
import { runMigrations } from './migrations.js';

async function main() {
  const config = loadConfig();
  const db = await createDatabaseAdapter(config);
  try {
    const applied = await runMigrations(db);
    console.log(
      JSON.stringify({
        status: 'ok',
        engine: db.engineType,
        appliedMigrations: applied
      })
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
