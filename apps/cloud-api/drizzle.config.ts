import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/accounts/adapters/persistence/auth-schema.ts',
    './src/company/adapters/persistence/tables.ts',
    './src/company/adapters/persistence/githubSchema.ts',
    './src/company/adapters/persistence/tokenMintSchema.ts',
  ],
  out: './drizzle',
});
