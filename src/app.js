import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
// Express 4 doesn't route a rejected Promise from an `async` handler into
// the error middleware below — it becomes an unhandled rejection and takes
// the whole process down (this is exactly what happened the first time a
// DB call failed inside an async route). This patches every router method
// to catch async errors and forward them to `next(err)` automatically.
import 'express-async-errors';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { chatRouter } from './routes/chat.js';
import { groupsRouter } from './routes/groups.js';
import { syncRouter } from './routes/sync.js';
import { pollsRouter } from './routes/polls.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' })); // sync pushes can carry a full mess history
  app.use(pinoHttp({ level: process.env.LOG_LEVEL || 'info' }));

  app.get('/health', (req, res) => res.json({ ok: true }));

  // Master Admin dashboard static assets (index.html/app.js/style.css) must
  // be matched *before* adminRouter: adminRouter's `requireAuth` is
  // registered with no path scope, so it runs for every request that
  // reaches it, and would otherwise 401 the page before it can even load
  // and show its own sign-in button. express.static calls next() for any
  // path with no matching file (e.g. /admin/groups), which correctly falls
  // through to adminRouter's auth-gated API route below.
  app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));

  app.use(authRouter);
  app.use(groupsRouter);
  app.use(syncRouter);
  app.use(pollsRouter);
  app.use(chatRouter);
  app.use(adminRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    req.log?.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
