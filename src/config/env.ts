import { config as loadDotenv } from 'dotenv';
import { expand } from 'dotenv-expand';
import { z } from 'zod';

// Load .env and resolve ${VAR} references (DATABASE_URL is built from the POSTGRES_* values).
// Skipped under test: the test scripts load .env.test via dotenv-cli, and loading .env here
// could point the suite at the dev database.
if (process.env.NODE_ENV !== 'test') {
    expand(loadDotenv());
}

/** Empty strings in .env (e.g. `AI_API_KEY=`) are treated as "not set". */
const optionalString = z
    .string()
    .optional()
    .transform((value) => (value ? value : undefined));

const EnvSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DATABASE_URL: z.string().min(1),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
    INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),

    CORS_ORIGIN: z.string().default('*'),

    UPLOAD_DIR: z.string().default('./uploads'),
    MAX_UPLOAD_MB: z.coerce.number().positive().default(10),

    AI_PROVIDER: optionalString,
    AI_API_KEY: optionalString,
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
    // Fail fast at boot instead of failing later on first use of a missing setting.
    console.error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
    process.exit(1);
}

export const env: Env = parsed.data;
