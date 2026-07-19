import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, loadGroupContext } from '../middleware/auth.js';

export const chatRouter = Router();
chatRouter.use(requireAuth);

/**
 * Message history, newest-first, paged via `before` (epoch ms). Real-time
 * delivery happens over the socket (see `src/chat/socket.js`) — this is
 * just initial load on opening the chat screen and catch-up after being
 * offline, so the app never has to hold a persistent connection just to
 * read messages.
 */
chatRouter.get('/groups/:id/messages', loadGroupContext, async (req, res) => {
  if (!req.membership) return res.status(403).json({ error: 'not_a_member' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const before = req.query.before ? Number(req.query.before) : Date.now();
  const [rows] = await pool.query(
    `SELECT id, group_id AS groupId, member_id AS memberId, text, client_nonce AS clientNonce, created_at AS createdAt
     FROM chat_messages WHERE group_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
    [req.params.id, before, limit],
  );
  res.json({ messages: rows });
});
