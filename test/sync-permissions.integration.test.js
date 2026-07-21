// SQA: does the generic sync push respect roles/permissions, or can a plain
// member write things the UI would never let them touch? The push route is
// only gated by membership + blockIfExpired — these tests pin down exactly
// what that does and doesn't allow, so the boundary is documented rather
// than assumed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { signAccessToken } from '../src/utils/jwt.js';

after(async () => {
  await pool.end();
});

async function createUser() {
  const id = randomUUID();
  const email = `${id}@sqa.local`;
  await pool.query('INSERT INTO users (id, google_sub, email, created_at) VALUES (?,?,?,?)', [id, id, email, Date.now()]);
  return { id, email, token: signAccessToken({ id, email }) };
}

async function messWithPlainMember(app) {
  const owner = await createUser();
  const groupId = randomUUID();
  const adminMemberId = randomUUID();
  const created = await request(app)
    .post('/groups')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ id: groupId, name: 'SQA Mess', appAdminMemberId: adminMemberId, appAdminName: 'Owner' });
  assert.equal(created.status, 201);

  const member = await createUser();
  const joined = await request(app)
    .post('/groups/join')
    .set('Authorization', `Bearer ${member.token}`)
    .send({ code: created.body.inviteCode, memberName: 'Plain Member' });
  assert.equal(joined.status, 200);

  return { owner, adminMemberId, groupId, member, memberId: joined.body.memberId };
}

const push = (app, groupId, token, changes) =>
  request(app).post(`/groups/${groupId}/sync/push`).set('Authorization', `Bearer ${token}`).send({ changes });

test('a non-member cannot push into a mess at all', async () => {
  const app = createApp();
  const { groupId } = await messWithPlainMember(app);
  const outsider = await createUser();

  const res = await push(app, groupId, outsider.token, {
    meals: [{ id: randomUUID(), groupId, memberId: randomUUID(), date: Date.now(), count: 1, guestCount: 0, updatedAt: Date.now() }],
  });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'not_a_member');
});

test('an unauthenticated push is rejected', async () => {
  const app = createApp();
  const { groupId } = await messWithPlainMember(app);
  const res = await request(app).post(`/groups/${groupId}/sync/push`).send({ changes: {} });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// The following pin down CURRENT behavior: the sync push does NOT enforce
// per-permission rules. A plain member is trusted to push any synced table
// for their own mess. These are regression anchors — if server-side
// per-row enforcement is added later, they are the tests to update.
// ---------------------------------------------------------------------------

test('DOCUMENTED GAP: a plain member can push another member\'s meal via sync', async () => {
  const app = createApp();
  const { groupId, adminMemberId, member } = await messWithPlainMember(app);

  const mealId = randomUUID();
  const now = Date.now();
  const res = await push(app, groupId, member.token, {
    // A meal for the ADMIN, pushed by a plain member — the app's UI only
    // lets a member edit their own row, but the server accepts this.
    meals: [{ id: mealId, groupId, memberId: adminMemberId, date: now, count: 9, guestCount: 0, updatedAt: now }],
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.results.meals[0].status, 'accepted');
  const [rows] = await pool.query('SELECT count FROM meals WHERE id = ?', [mealId]);
  assert.equal(rows.length, 1, 'server currently accepts a meal written for someone else');
});

test('SECURITY: can a plain member promote themselves to appAdmin via sync push?', async () => {
  const app = createApp();
  const { groupId, member, memberId } = await messWithPlainMember(app);

  const [before] = await pool.query('SELECT role FROM members WHERE id = ?', [memberId]);
  assert.equal(before[0].role, 'member');

  const res = await push(app, groupId, member.token, {
    members: [
      {
        id: memberId,
        groupId,
        name: 'Plain Member',
        joinDate: Date.now(),
        active: true,
        role: 'appAdmin', // <- privilege escalation attempt
        permissions: '',
        updatedAt: Date.now() + 60_000, // newer than stored, so LWW accepts it
      },
    ],
  });
  assert.equal(res.status, 200);

  const [after] = await pool.query('SELECT role FROM members WHERE id = ?', [memberId]);
  // The dedicated role route is App-Admin-only and non-delegable; the sync
  // push must not become a back door around it.
  assert.equal(
    after[0].role,
    'member',
    'PRIVILEGE ESCALATION: a plain member promoted themselves to appAdmin through the sync push',
  );
});

test('an App Admin CAN still push role changes through sync (fix must not over-block)', async () => {
  const app = createApp();
  const { owner, groupId, memberId } = await messWithPlainMember(app);

  const res = await push(app, groupId, owner.token, {
    members: [
      {
        id: memberId,
        groupId,
        name: 'Plain Member',
        joinDate: Date.now(),
        active: true,
        role: 'subAdmin',
        permissions: 'meals.manage',
        updatedAt: Date.now() + 60_000,
      },
    ],
  });
  assert.equal(res.status, 200);

  const [rows] = await pool.query('SELECT role, permissions FROM members WHERE id = ?', [memberId]);
  assert.equal(rows[0].role, 'subAdmin', 'the App Admin is allowed to set roles');
  assert.equal(rows[0].permissions, 'meals.manage');
});

test('a sub-admin (not App Admin) also cannot escalate via sync push', async () => {
  const app = createApp();
  const { owner, groupId, member, memberId } = await messWithPlainMember(app);

  // Owner legitimately makes them a sub-admin with meal rights only.
  await request(app)
    .patch(`/groups/${groupId}/members/${memberId}/role`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ role: 'subAdmin', permissions: ['meals.manage'] });

  // They then try to self-promote through sync.
  await push(app, groupId, member.token, {
    members: [
      {
        id: memberId,
        groupId,
        name: 'Plain Member',
        joinDate: Date.now(),
        active: true,
        role: 'appAdmin',
        permissions: 'members.manage',
        updatedAt: Date.now() + 120_000,
      },
    ],
  });

  const [rows] = await pool.query('SELECT role, permissions FROM members WHERE id = ?', [memberId]);
  assert.equal(rows[0].role, 'subAdmin', 'a sub-admin must not be able to promote themselves');
  assert.equal(rows[0].permissions, 'meals.manage', 'nor widen their own permissions');
});
