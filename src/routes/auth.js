import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { pool } from '../db.js';
import { config } from '../config.js';
import { requireAuth, checkMasterAdmin } from '../middleware/auth.js';
import { signAccessToken, generateRefreshToken, hashRefreshToken, refreshExpiryTimestamp } from '../utils/jwt.js';

export const authRouter = Router();
const googleClient = new OAuth2Client();

const googleSchema = z.object({ idToken: z.string().min(1) });

async function issueSession(user) {
  const access = signAccessToken(user);
  const refresh = generateRefreshToken();
  await pool.query(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked, created_at) VALUES (?, ?, ?, ?, FALSE, ?)',
    [uuid(), user.id, hashRefreshToken(refresh), refreshExpiryTimestamp(), Date.now()],
  );
  return { access, refresh };
}

authRouter.post('/auth/google', async (req, res) => {
  const parsed = googleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: parsed.data.idToken,
      audience: config.googleClientIds.length ? config.googleClientIds : undefined,
    });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: 'invalid_google_token' });
  }
  if (!payload?.sub || !payload.email) return res.status(401).json({ error: 'invalid_google_token' });

  const [existing] = await pool.query('SELECT * FROM users WHERE google_sub = ?', [payload.sub]);
  let user = existing[0];
  if (!user) {
    user = {
      id: uuid(),
      google_sub: payload.sub,
      email: payload.email,
      name: payload.name || null,
      photo_url: payload.picture || null,
      created_at: Date.now(),
    };
    await pool.query(
      'INSERT INTO users (id, google_sub, email, name, photo_url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [user.id, user.google_sub, user.email, user.name, user.photo_url, user.created_at],
    );
  } else {
    // Keep name/photo fresh on every sign-in.
    await pool.query('UPDATE users SET name = ?, photo_url = ? WHERE id = ?', [payload.name || null, payload.picture || null, user.id]);
  }

  const session = await issueSession({ id: user.id, email: user.email });
  res.json({ ...session, user: { id: user.id, email: user.email, name: payload.name, photoUrl: payload.picture } });
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

authRouter.post('/auth/refresh', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const tokenHash = hashRefreshToken(parsed.data.refreshToken);
  const [rows] = await pool.query('SELECT * FROM refresh_tokens WHERE token_hash = ?', [tokenHash]);
  const record = rows[0];
  if (!record || record.revoked || Number(record.expires_at) < Date.now()) {
    return res.status(401).json({ error: 'invalid_refresh_token' });
  }

  const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [record.user_id]);
  const user = users[0];
  if (!user) return res.status(401).json({ error: 'invalid_refresh_token' });

  // Rotate: revoke the used token, issue a new pair.
  await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = ?', [record.id]);
  const session = await issueSession({ id: user.id, email: user.email });
  res.json(session);
});

authRouter.post('/auth/logout', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = ?', [hashRefreshToken(parsed.data.refreshToken)]);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, checkMasterAdmin, async (req, res) => {
  const [users] = await pool.query('SELECT id, email, name, photo_url, created_at FROM users WHERE id = ?', [req.user.id]);
  if (!users[0]) return res.status(404).json({ error: 'user_not_found' });
  res.json({ ...users[0], isMasterAdmin: req.isMasterAdmin });
});

const deviceTokenSchema = z.object({ fcmToken: z.string().min(1) });

/** Registers/refreshes this device's FCM token for chat push (Step 7 follow-up). */
authRouter.post('/me/device-token', requireAuth, async (req, res) => {
  const parsed = deviceTokenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  await pool.query(
    `INSERT INTO device_tokens (user_id, fcm_token, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)`,
    [req.user.id, parsed.data.fcmToken, Date.now()],
  );
  res.status(204).end();
});
