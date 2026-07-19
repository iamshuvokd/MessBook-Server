import http from 'node:http';
import { createApp } from './app.js';
import { attachSocketServer } from './chat/socket.js';
import { config } from './config.js';

if (config.isProduction && config.jwt.secret === 'dev-secret-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}

// Last-resort safety net for anything outside an Express request (Socket.IO
// handlers already catch their own errors) — log and keep running instead
// of taking the whole server down, which is what an uncaught DB error did
// before `express-async-errors` was wired into app.js.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server stayed up):', err);
});

const app = createApp();
const httpServer = http.createServer(app);
attachSocketServer(httpServer);

httpServer.listen(config.port, () => {
  console.log(`mess-manager-server listening on :${config.port}`);
});
