/**
 * Demo data for local development. Wipes all tables first, so never point it at real data.
 * Run with: npm run db:seed
 *
 * Logins (password for both: Password123!)
 *   alice@example.com  owner of "Website Revamp"
 *   bob@example.com    member of "Website Revamp"
 */
import { PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';

const prisma = new PrismaClient();
const DAY_MS = 24 * 60 * 60 * 1000;

async function resetTables() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

async function main() {
  await resetTables();

  const passwordHash = await hash('Password123!', { type: argon2id });
  const now = Date.now();

  const alice = await prisma.user.create({
    data: { email: 'alice@example.com', name: 'Alice Sharma', passwordHash },
  });
  const bob = await prisma.user.create({
    data: { email: 'bob@example.com', name: 'Bob Verma', passwordHash },
  });

  const project = await prisma.project.create({
    data: {
      name: 'Website Revamp',
      description: 'Redesign and relaunch the marketing site.',
      createdById: alice.id,
      members: {
        create: [
          { userId: alice.id, role: 'OWNER' },
          { userId: bob.id, role: 'MEMBER' },
        ],
      },
    },
  });

  const tasks = await prisma.task.createManyAndReturn({
    data: [
      {
        projectId: project.id,
        title: 'Set up CI pipeline',
        description: 'Lint, typecheck and test on every push.',
        status: 'COMPLETED',
        completedAt: new Date(now - DAY_MS),
        priority: 'HIGH',
        dueDate: new Date(now - 2 * DAY_MS),
        createdById: alice.id,
        assigneeId: alice.id,
      },
      {
        projectId: project.id,
        title: 'Design new landing page',
        description: 'Hero section, pricing table and testimonials.',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
        dueDate: new Date(now + 3 * DAY_MS),
        createdById: alice.id,
        assigneeId: bob.id,
      },
      {
        projectId: project.id,
        title: 'Fix login redirect bug',
        description: 'Users land on a 404 after logging in from the pricing page.',
        status: 'OPEN',
        priority: 'URGENT',
        dueDate: new Date(now + 1 * DAY_MS),
        createdById: bob.id,
      },
      {
        projectId: project.id,
        title: 'Write launch announcement',
        status: 'OPEN',
        priority: 'LOW',
        createdById: alice.id,
        assigneeId: bob.id,
      },
    ],
  });

  const landingPage = tasks.find((t) => t.title === 'Design new landing page');

  await prisma.comment.createMany({
    data: [
      { projectId: project.id, authorId: alice.id, body: 'Kickoff: target launch is end of month.' },
      ...(landingPage
        ? [
            {
              projectId: project.id,
              taskId: landingPage.id,
              authorId: bob.id,
              body: 'First draft of the hero section is up for review.',
            },
          ]
        : []),
    ],
  });

  console.log(`Seeded 2 users, 1 project, ${tasks.length} tasks, 2 comments.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
