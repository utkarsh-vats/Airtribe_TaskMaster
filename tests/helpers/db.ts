import { prisma } from '../../src/db/prisma';

/** Empties every application table. Call in beforeEach/beforeAll of integration test files. */
export async function resetDb(): Promise<void> {
    // Guard against wiping a real database if the env is misconfigured.
    const [{ current_database: dbName } = { current_database: '' }] = await prisma.$queryRaw<
        { current_database: string }[]
    >`SELECT current_database()`;
    if (!dbName.endsWith('_test')) {
        throw new Error(`Refusing to reset "${dbName}": test database names must end in _test`);
    }

    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    if (tables.length === 0) return;
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
