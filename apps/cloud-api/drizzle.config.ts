import { defineConfig } from 'drizzle-kit';

// The app's one migration chain, from both parts' tables: the files `src/persistence/database.ts`
// puts together as the one schema.
export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/accounts/adapters/persistence/auth-schema.ts',
    './src/company/adapters/persistence/tables.ts',
    './src/company/adapters/persistence/gitHubTables.ts',
  ],
  out: './drizzle',
});
