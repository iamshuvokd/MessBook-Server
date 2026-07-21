// End-to-end test of the live-update path: a REST sync push must broadcast
// `dataChanged` over Socket.IO to every OTHER device connected to the same
// group room. This is the exact mechanism the app's "instant meal update"
// relies on, and it can only be exercised with a real Socket.IO server +
// real socket clients in the same process (so the push handler's
// `broadcastDataChanged` sees the `ioInstance` that `attachSocketServer`
// sets). Runs against the real Docker/CI MySQL, like the other integration
// tests.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { attachSocketServer } from '../src/chat/socket.js';
import { pool } from '../src/db.js';
import { signAccessToken } from '../src/utils/jwt.js';

// One shared HTTP server hosting BOTH the Express app and the Socket.IO
// server, so a REST push and the socket broadcast happen in the same process.
const app = createApp();
const httpServer = http.createServer(app);
attachSocketServer(httpServer);
let baseUrl;
const openSockets = [];

const ready = new Promise((resolve) => {
  httpServer.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    resolve();
  });
});

after(async () => {
  for (const s of openSockets) s.close();
  await new Promise((r) => httpServer.close(r));
  await pool.end();
});

async function createUser() {
  const id = randomUUID();
  const email = `${id}@rt.local`;
  await pool.query('INSERT INTO users (id, google_sub, email, created_at) VALUES (?,?,?,?)', [id, id, email, Date.now()]);
  return { id, email, token: signAccessToken({ id, email }) };
}

async function post(path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { transports: ['websocket'], auth: { token } });
    openSockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 8000);
  });
}

const joinGroup = (socket, groupId) => new Promise((resolve) => socket.emit('joinGroup', groupId, resolve));
const nextDataChanged = (socket, timeoutMs = 5000) =>
  new Promise((resolve) => {
    socket.once('dataChanged', resolve);
    setTimeout(() => resolve(null), timeoutMs);
  });

async function onlineGroupWithTwoMembers() {
  await ready;
  const owner = await createUser();
  const groupId = randomUUID();
  const adminMemberId = randomUUID();
  const created = await post('/groups', owner.token, {
    id: groupId,
    name: 'Realtime Mess',
    appAdminMemberId: adminMemberId,
    appAdminName: 'Owner',
  });
  assert.equal(created.status, 201);
  const member = await createUser();
  const joined = await post('/groups/join', member.token, { code: created.body.inviteCode, memberName: 'Member B' });
  assert.equal(joined.status, 200);
  return { owner, member, groupId, adminMemberId };
}

function mealPush(groupId, memberId) {
  const now = Date.now();
  return {
    changes: {
      categories: [{ id: randomUUID(), groupId, name: 'Bazar', isMealCategory: true, icon: 'x', updatedAt: now }],
      meals: [{ id: randomUUID(), groupId, memberId, date: now, count: 2, guestCount: 0, updatedAt: now }],
    },
  };
}

test('a sync push broadcasts dataChanged to another member connected to the group room', async () => {
  const { owner, member, groupId, adminMemberId } = await onlineGroupWithTwoMembers();

  const sockA = await connectSocket(owner.token);
  const sockB = await connectSocket(member.token);
  assert.deepEqual(await joinGroup(sockA, groupId), { ok: true });
  assert.deepEqual(await joinGroup(sockB, groupId), { ok: true });

  const received = nextDataChanged(sockB);
  const push = await post(`/groups/${groupId}/sync/push`, owner.token, mealPush(groupId, adminMemberId));
  assert.equal(push.status, 200);

  const payload = await received;
  assert.ok(payload, 'member B must receive a dataChanged event after the push');
  assert.ok(payload.tables.includes('meals'), 'the changed table set must include meals');
  assert.ok(typeof payload.serverTimeMs === 'number');
});

test('dataChanged is scoped to the room — a member of a DIFFERENT group never receives it', async () => {
  const groupOne = await onlineGroupWithTwoMembers();
  const groupTwo = await onlineGroupWithTwoMembers();

  const sockOne = await connectSocket(groupOne.member.token);
  const sockTwo = await connectSocket(groupTwo.member.token);
  await joinGroup(sockOne, groupOne.groupId);
  await joinGroup(sockTwo, groupTwo.groupId);

  const outsiderHeard = nextDataChanged(sockTwo, 2500);
  await post(`/groups/${groupOne.groupId}/sync/push`, groupOne.owner.token, mealPush(groupOne.groupId, groupOne.adminMemberId));

  assert.equal(await outsiderHeard, null, 'a push in group one must not leak to a group-two subscriber');
});

test('a socket that never joined the room does not receive dataChanged', async () => {
  const { owner, member, groupId, adminMemberId } = await onlineGroupWithTwoMembers();

  const sockB = await connectSocket(member.token); // connected but deliberately NOT joined
  const heard = nextDataChanged(sockB, 2500);
  await post(`/groups/${groupId}/sync/push`, owner.token, mealPush(groupId, adminMemberId));

  assert.equal(await heard, null, 'membership in the room (joinGroup) is required to receive broadcasts');
});

test('a push that changes nothing (all conflicts) broadcasts no dataChanged', async () => {
  const { owner, member, groupId, adminMemberId } = await onlineGroupWithTwoMembers();

  // First push establishes a newer row.
  const now = Date.now();
  const catId = randomUUID();
  const mealId = randomUUID();
  await post(`/groups/${groupId}/sync/push`, owner.token, {
    changes: {
      categories: [{ id: catId, groupId, name: 'Bazar', isMealCategory: true, icon: 'x', updatedAt: now }],
      meals: [{ id: mealId, groupId, memberId: adminMemberId, date: now, count: 2, guestCount: 0, updatedAt: now }],
    },
  });

  const sockB = await connectSocket(member.token);
  await joinGroup(sockB, groupId);
  const heard = nextDataChanged(sockB, 2500);

  // Re-push the SAME meal with an OLDER updatedAt — server reports conflict, applies nothing.
  const conflictPush = await post(`/groups/${groupId}/sync/push`, owner.token, {
    changes: {
      meals: [{ id: mealId, groupId, memberId: adminMemberId, date: now, count: 9, guestCount: 0, updatedAt: now - 50_000 }],
    },
  });
  assert.equal(conflictPush.body.results.meals[0].status, 'conflict');

  assert.equal(await heard, null, 'no accepted rows means no dataChanged broadcast');
});
