import fs from 'node:fs';
import path from 'node:path';
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getMessaging as getMessagingForApp } from 'firebase-admin/messaging';
import { config } from '../config.js';
import { pool } from '../db.js';

let messaging; // undefined = not attempted yet, null = attempted and unavailable

function getMessaging() {
  if (messaging !== undefined) return messaging;

  const keyPath = path.resolve(config.firebaseServiceAccountPath);
  if (!fs.existsSync(keyPath)) {
    console.warn(`Firebase service account not found at ${keyPath} — chat push disabled (socket delivery still works).`);
    messaging = null;
    return messaging;
  }

  try {
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const app = getApps().length ? getApp() : initializeApp({ credential: cert(serviceAccount) });
    messaging = getMessagingForApp(app);
  } catch (err) {
    console.error('Failed to initialize Firebase Admin for push:', err.message);
    messaging = null;
  }
  return messaging;
}

/**
 * Pushes a new chat message to every *other* linked member of a group who
 * isn't connected to the socket right now — this is purely the
 * app-backgrounded/killed fallback; real-time delivery already happened
 * over Socket.IO before this is ever called. Best-effort: any failure here
 * (missing key, FCM error, no recipients) is swallowed, never thrown.
 */
export async function pushNewChatMessage({ groupId, senderMemberId, senderName, groupName, text }) {
  const fcm = getMessaging();
  if (!fcm) return;

  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT dt.fcm_token FROM device_tokens dt
       JOIN members m ON m.user_id = dt.user_id
       WHERE m.group_id = ? AND m.active = TRUE AND m.id != ?`,
      [groupId, senderMemberId],
    );
    const tokens = rows.map((r) => r.fcm_token);
    if (tokens.length === 0) return;

    const response = await fcm.sendEachForMulticast({
      tokens,
      notification: { title: groupName, body: `${senderName}: ${text}` },
      data: { groupId },
    });

    const stale = [];
    response.responses.forEach((r, i) => {
      const code = r.error?.code;
      if (!r.success && (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered')) {
        stale.push(tokens[i]);
      }
    });
    if (stale.length > 0) {
      await pool.query(`DELETE FROM device_tokens WHERE fcm_token IN (${stale.map(() => '?').join(',')})`, stale);
    }
  } catch (err) {
    console.error('FCM send failed:', err.message);
  }
}

/**
 * Pushes to every *other* linked member of a group when someone joins.
 * Membership changes have no socket/real-time channel at all (unlike chat),
 * so this is the only thing that makes a new member show up on another
 * device without that device manually pulling to refresh or waiting for its
 * next periodic sync. `data.type` lets the client trigger a sync on receipt
 * instead of just displaying a notification. Best-effort, like chat push.
 */
/**
 * Notifies every *other* linked member of a group that a new meal poll was
 * created, so they know to go vote — the in-app live update (dataChanged)
 * already covers members with the app open; this is the backgrounded/killed
 * fallback. Best-effort, same as the others. Resolves the group and creator
 * names itself so callers only pass ids.
 */
export async function pushPollCreated({ groupId, pollTitle, createdByMemberId, excludeUserId }) {
  const fcm = getMessaging();
  if (!fcm) return;

  try {
    const [grpRows] = await pool.query('SELECT name FROM `groups` WHERE id = ?', [groupId]);
    const groupName = grpRows[0]?.name ?? 'Mess';
    const [creatorRows] = await pool.query('SELECT name FROM members WHERE id = ?', [createdByMemberId]);
    const creatorName = creatorRows[0]?.name ?? '';

    const [rows] = await pool.query(
      `SELECT DISTINCT dt.fcm_token FROM device_tokens dt
       JOIN members m ON m.user_id = dt.user_id
       WHERE m.group_id = ? AND m.active = TRUE AND m.user_id != ?`,
      [groupId, excludeUserId],
    );
    const tokens = rows.map((r) => r.fcm_token);
    if (tokens.length === 0) return;

    const body = pollTitle && pollTitle.trim() ? pollTitle.trim() : (creatorName ? `${creatorName} started a meal poll` : 'New meal poll — tap to vote');
    const response = await fcm.sendEachForMulticast({
      tokens,
      notification: { title: groupName, body },
      data: { groupId, type: 'pollCreated' },
    });

    const stale = [];
    response.responses.forEach((r, i) => {
      const code = r.error?.code;
      if (!r.success && (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered')) {
        stale.push(tokens[i]);
      }
    });
    if (stale.length > 0) {
      await pool.query(`DELETE FROM device_tokens WHERE fcm_token IN (${stale.map(() => '?').join(',')})`, stale);
    }
  } catch (err) {
    console.error('FCM send failed:', err.message);
  }
}

export async function pushMemberJoined({ groupId, groupName, newMemberName, excludeUserId }) {
  const fcm = getMessaging();
  if (!fcm) return;

  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT dt.fcm_token FROM device_tokens dt
       JOIN members m ON m.user_id = dt.user_id
       WHERE m.group_id = ? AND m.active = TRUE AND m.user_id != ?`,
      [groupId, excludeUserId],
    );
    const tokens = rows.map((r) => r.fcm_token);
    if (tokens.length === 0) return;

    const response = await fcm.sendEachForMulticast({
      tokens,
      notification: { title: groupName, body: `${newMemberName} joined the mess` },
      data: { groupId, type: 'memberJoined' },
    });

    const stale = [];
    response.responses.forEach((r, i) => {
      const code = r.error?.code;
      if (!r.success && (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered')) {
        stale.push(tokens[i]);
      }
    });
    if (stale.length > 0) {
      await pool.query(`DELETE FROM device_tokens WHERE fcm_token IN (${stale.map(() => '?').join(',')})`, stale);
    }
  } catch (err) {
    console.error('FCM send failed:', err.message);
  }
}
