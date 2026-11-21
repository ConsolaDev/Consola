import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/adapters/persistence/auth-schema.ts',
  out: './drizzle',
});
