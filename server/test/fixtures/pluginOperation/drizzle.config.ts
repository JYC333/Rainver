import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './test/fixtures/pluginOperation/schema.ts',
  out: './test/fixtures/pluginOperation/migrations'
});
