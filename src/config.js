import 'dotenv/config';

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'mess_manager',
  },
  jwt: {
    // Dev-only fallback secret so `npm run dev` works before .env exists;
    // production MUST set a real JWT_SECRET (checked at boot in server.js).
    secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    accessTtl: '15m',
    refreshTtlDays: 30,
  },
  // Socket.IO Redis adapter — lets `io.to(room).emit(...)` reach clients
  // connected to any API instance, not just the one that handled the
  // triggering request. Optional: unset locally (`npm run dev` outside
  // Docker) falls back to Socket.IO's built-in single-process adapter.
  redis: { url: process.env.REDIS_URL || null },
  googleClientIds: (process.env.GOOGLE_CLIENT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  masterAdminEmails: (process.env.MASTER_ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  isProduction: process.env.NODE_ENV === 'production',
  // Chat push (Step 7 follow-up). Missing/unreadable file = pushes are
  // silently skipped (see src/push/fcm.js) — sockets/REST stay unaffected,
  // matching the app's "sync is opportunistic, never a hard dependency" rule.
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './secrets/firebase-service-account.json',
};

export { required };
