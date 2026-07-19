import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { v4 as uuid } from 'uuid';
import { verifyAccessToken } from '../utils/jwt.js';
import { pool } from '../db.js';
import { pushNewChatMessage } from '../push/fcm.js';
import { config } from '../config.js';

// Set once `attachSocketServer` runs — every other module that needs to
// push into a group's room (currently: sync.js broadcasting `dataChanged`
// after a push) imports `getIo()`/`broadcastDataChanged()` rather than
// threading the `io` instance through every route.
let ioInstance = null;

/**
 * One Socket.IO room per group (`group:<id>`). Auth mirrors the REST API —
 * the same short-lived JWT access token, passed as `auth.token` in the
 * handshake (not a query param, so it never lands in server access logs).
 * A socket only receives messages for groups it has explicitly joined via
 * `joinGroup`, which re-checks membership server-side rather than trusting
 * whatever room name the client asks for.
 */
export function attachSocketServer(httpServer) {
  const io = new Server(httpServer, { cors: { origin: '*' } });

  if (config.redis.url) {
    const pubClient = new Redis(config.redis.url);
    const subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
  }

  ioInstance = io;

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) throw new Error('missing_token');
      const payload = verifyAccessToken(token);
      socket.userId = payload.sub;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('joinGroup', async (groupId, ack) => {
      try {
        const [rows] = await pool.query(
          'SELECT id FROM members WHERE group_id = ? AND user_id = ? AND active = TRUE',
          [groupId, socket.userId],
        );
        if (rows.length === 0) return ack?.({ error: 'not_a_member' });
        socket.join(`group:${groupId}`);
        ack?.({ ok: true });
      } catch {
        ack?.({ error: 'join_failed' });
      }
    });

    socket.on('sendMessage', async (payload, ack) => {
      try {
        const groupId = payload?.groupId;
        const text = (payload?.text || '').trim();
        if (!groupId || !text) return ack?.({ error: 'invalid_message' });

        const [rows] = await pool.query(
          'SELECT id, name FROM members WHERE group_id = ? AND user_id = ? AND active = TRUE',
          [groupId, socket.userId],
        );
        const member = rows[0];
        if (!member) return ack?.({ error: 'not_a_member' });

        const message = {
          id: uuid(),
          groupId,
          memberId: member.id,
          text,
          clientNonce: payload?.clientNonce ?? null,
          createdAt: Date.now(),
        };
        await pool.query(
          'INSERT INTO chat_messages (id, group_id, member_id, text, client_nonce, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [message.id, message.groupId, message.memberId, message.text, message.clientNonce, message.createdAt],
        );

        io.to(`group:${groupId}`).emit('newMessage', message);
        ack?.({ ok: true, message });

        // Push fallback for members not connected to the socket right now
        // (app backgrounded/killed) — fire-and-forget, never blocks the ack.
        const [groupRows] = await pool.query('SELECT name FROM `groups` WHERE id = ?', [groupId]);
        pushNewChatMessage({
          groupId,
          senderMemberId: member.id,
          senderName: member.name,
          groupName: groupRows[0]?.name ?? 'Mess Chat',
          text,
        }).catch(() => {});
      } catch {
        ack?.({ error: 'send_failed' });
      }
    });
  });

  return io;
}

export function getIo() {
  if (!ioInstance) throw new Error('Socket server not initialized yet');
  return ioInstance;
}

/**
 * Nudges every device currently viewing [groupId] (connected to the
 * `group:<id>` room from the same `joinGroup` chat already uses) to pull
 * the sync REST API immediately instead of waiting for its next periodic
 * pull. Fire-and-forget: a group with nobody connected, or the socket
 * server not initialized yet (e.g. an isolated test importing sync.js
 * directly), is a silent no-op rather than an error.
 */
export function broadcastDataChanged(groupId, tables) {
  if (!ioInstance || !tables || tables.length === 0) return;
  ioInstance.to(`group:${groupId}`).emit('dataChanged', { tables, serverTimeMs: Date.now() });
}
