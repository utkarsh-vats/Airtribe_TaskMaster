import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import * as authController from './auth.controller';
import { loginBodySchema, refreshTokenBodySchema, registerBodySchema } from './auth.schemas';

export const authRouter = Router();

// 10 requests per minute per IP (DESIGN §6). Skipped under NODE_ENV=test.
authRouter.use(createRateLimiter({ windowMs: 60_000, limit: 10 }));

authRouter.post('/register', validate({ body: registerBodySchema }), authController.register);
authRouter.post('/login', validate({ body: loginBodySchema }), authController.login);
authRouter.post('/refresh', validate({ body: refreshTokenBodySchema }), authController.refresh);
authRouter.post('/logout', validate({ body: refreshTokenBodySchema }), authController.logout);
authRouter.post('/logout-all', authenticate, authController.logoutAll);
