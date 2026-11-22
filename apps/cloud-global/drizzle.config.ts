import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/adapters/persistence/auth-schema.ts',
    './src/adapters/persistence/outboxSchema.ts',
    './src/adapters/persistence/githubSchema.ts',
    './src/adapters/persistence/tokenMintSchema.ts',
  ],
  out: './drizzle',
});
