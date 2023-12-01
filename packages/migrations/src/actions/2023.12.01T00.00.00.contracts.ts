import type { MigrationExecutor } from '../pg-migrator';

export default {
  name: '2023.12.01T00.00.00.contracts.ts',
  run: ({ sql }) => sql`
    ALTER TABLE "schema_versions"
      ADD COLUMN "tags" text[]
    ;
  `,
} satisfies MigrationExecutor;
