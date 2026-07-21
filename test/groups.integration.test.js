// Real-MySQL integration tests for src/routes/groups.js — see
// sync.integration.test.js's header comment for why these need a real DB.
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

async function createTestUser() {
  const id = randomUUID();
  const email = `${id}@test.local`;
  await pool.query('INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)', [
    id,
    id,
    email,
    Date.now(),
  ]);
  return { id, email, token: signAccessToken({ id, email }) };
}

async function bringGroupOnline(app, token, { appAdminMemberId } = {}) {
  const groupId = randomUUID();
  const res = await request(app)
    .post('/groups')
    .set('Authorization', `Bearer ${token}`)
    .send({ id: groupId, name: 'Integration Test Mess', appAdminMemberId: appAdminMemberId ?? randomUUID(), appAdminName: 'Admin' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { groupId, inviteCode: res.body.inviteCode };
}

async function insertUnclaimedMember(groupId, name) {
  const id = randomUUID();
  const now = Date.now();
  await pool.query(
    'INSERT INTO members (id, group_id, user_id, name, join_date, active, role, permissions, updated_at) VALUES (?, ?, NULL, ?, ?, TRUE, ?, ?, ?)',
    [id, groupId, name, now, 'member', '', now],
  );
  return id;
}

test('bringing a mess online mints a unique MESS-XXXX invite code', async () => {
  const app = createApp();
  const user = await createTestUser();
  const { inviteCode } = await bringGroupOnline(app, user.token);
  assert.match(inviteCode, /^MESS-[0-9A-Z]{4}$/);
});

test('joining with an existing (unclaimed) memberId claims that member instead of creating a duplicate', async () => {
  const app = createApp();
  const owner = await createTestUser();
  const { groupId, inviteCode } = await bringGroupOnline(app, owner.token, { appAdminMemberId: randomUUID() });
  const unclaimedId = await insertUnclaimedMember(groupId, 'Rahim');

  const lookupRes = await request(app)
    .get(`/groups/join/${inviteCode}/members`)
    .set('Authorization', `Bearer ${owner.token}`);
  assert.equal(lookupRes.status, 200);
  assert.ok(lookupRes.body.members.some((m) => m.id === unclaimedId));

  const joiner = await createTestUser();
  const joinRes = await request(app)
    .post('/groups/join')
    .set('Authorization', `Bearer ${joiner.token}`)
    .send({ code: inviteCode, existingMemberId: unclaimedId });
  assert.equal(joinRes.status, 200);
  assert.equal(joinRes.body.memberId, unclaimedId);

  const [rows] = await pool.query('SELECT user_id FROM members WHERE id = ?', [unclaimedId]);
  assert.equal(rows[0].user_id, joiner.id);
});

test('joining with a new member name creates a brand-new member row linked to the caller', async () => {
  const app = createApp();
  const owner = await createTestUser();
  const { groupId, inviteCode } = await bringGroupOnline(app, owner.token, { appAdminMemberId: randomUUID() });

  const joiner = await createTestUser();
  const joinRes = await request(app)
    .post('/groups/join')
    .set('Authorization', `Bearer ${joiner.token}`)
    .send({ code: inviteCode, memberName: 'New Person' });
  assert.equal(joinRes.status, 200);

  const [rows] = await pool.query('SELECT name, group_id, user_id FROM members WHERE id = ?', [joinRes.body.memberId]);
  assert.equal(rows[0].group_id, groupId);
  assert.equal(rows[0].name, 'New Person');
  assert.equal(rows[0].user_id, joiner.id);
});

test('joining an invalid invite code is rejected', async () => {
  const app = createApp();
  const user = await createTestUser();
  const res = await request(app)
    .post('/groups/join')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ code: 'MESS-0000' });
  assert.equal(res.status, 404);
});

test('only the App Admin can assign a role, and it is applied correctly', async () => {
  const app = createApp();
  const owner = await createTestUser();
  const adminMemberId = randomUUID();
  const { groupId, inviteCode } = await bringGroupOnline(app, owner.token, { appAdminMemberId: adminMemberId });

  const member = await createTestUser();
  const joinRes = await request(app)
    .post('/groups/join')
    .set('Authorization', `Bearer ${member.token}`)
    .send({ code: inviteCode, memberName: 'Sub Admin Candidate' });
  const subAdminMemberId = joinRes.body.memberId;

  // A non-admin member cannot assign roles.
  const deniedRes = await request(app)
    .patch(`/groups/${groupId}/members/${subAdminMemberId}/role`)
    .set('Authorization', `Bearer ${member.token}`)
    .send({ role: 'subAdmin', permissions: ['meals.manage'] });
  assert.equal(deniedRes.status, 403);

  // The App Admin can.
  const grantRes = await request(app)
    .patch(`/groups/${groupId}/members/${subAdminMemberId}/role`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ role: 'subAdmin', permissions: ['meals.manage', 'polls.create'] });
  assert.equal(grantRes.status, 204);

  const [rows] = await pool.query('SELECT role, permissions FROM members WHERE id = ?', [subAdminMemberId]);
  assert.equal(rows[0].role, 'subAdmin');
  assert.equal(rows[0].permissions, 'meals.manage,polls.create');
});

test('transferring ownership promotes the target, demotes the caller, and moves group ownership', async () => {
  const app = createApp();
  const owner = await createTestUser();
  const adminMemberId = randomUUID();
  const { groupId, inviteCode } = await bringGroupOnline(app, owner.token, { appAdminMemberId: adminMemberId });

  const newOwner = await createTestUser();
  const joinRes = await request(app)
    .post('/groups/join')
    .set('Authorization', `Bearer ${newOwner.token}`)
    .send({ code: inviteCode, memberName: 'Future Admin' });
  const newOwnerMemberId = joinRes.body.memberId;

  const transferRes = await request(app)
    .post(`/groups/${groupId}/transfer-ownership`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ newOwnerMemberId });
  assert.equal(transferRes.status, 204);

  const [[newAdminRow], [oldAdminRow], [groupRow]] = await Promise.all([
    pool.query('SELECT role FROM members WHERE id = ?', [newOwnerMemberId]).then((r) => r[0]),
    pool.query('SELECT role FROM members WHERE id = ?', [adminMemberId]).then((r) => r[0]),
    pool.query('SELECT owner_user_id FROM `groups` WHERE id = ?', [groupId]).then((r) => r[0]),
  ]);
  assert.equal(newAdminRow.role, 'appAdmin');
  assert.equal(oldAdminRow.role, 'member');
  assert.equal(groupRow.owner_user_id, newOwner.id);

  // The old admin, now a plain member, can no longer assign roles.
  const deniedRes = await request(app)
    .patch(`/groups/${groupId}/members/${newOwnerMemberId}/role`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ role: 'member', permissions: [] });
  assert.equal(deniedRes.status, 403);
});

test('a bazar duty can be deleted server-side (so it does not reappear on the next pull)', async () => {
  const app = createApp();
  const owner = await createTestUser();
  const adminMemberId = randomUUID();
  const { groupId } = await bringGroupOnline(app, owner.token, { appAdminMemberId: adminMemberId });

  const dutyId = randomUUID();
  const now = Date.now();
  await pool.query(
    'INSERT INTO bazar_duties (id, group_id, member_id, date, done, updated_at) VALUES (?, ?, ?, ?, FALSE, ?)',
    [dutyId, groupId, adminMemberId, now, now],
  );

  const res = await request(app).delete(`/groups/${groupId}/bazar/${dutyId}`).set('Authorization', `Bearer ${owner.token}`);
  assert.equal(res.status, 204);

  const [rows] = await pool.query('SELECT id FROM bazar_duties WHERE id = ?', [dutyId]);
  assert.equal(rows.length, 0, 'the duty must be gone server-side, not just locally');
});

test('a plain member cannot delete a bazar duty', async () => {
  const app = createApp();
  const owner = await createTestUser();
  const adminMemberId = randomUUID();
  const { groupId, inviteCode } = await bringGroupOnline(app, owner.token, { appAdminMemberId: adminMemberId });

  const joiner = await createTestUser();
  await request(app).post('/groups/join').set('Authorization', `Bearer ${joiner.token}`).send({ code: inviteCode, memberName: 'Plain' });

  const dutyId = randomUUID();
  const now = Date.now();
  await pool.query(
    'INSERT INTO bazar_duties (id, group_id, member_id, date, done, updated_at) VALUES (?, ?, ?, ?, FALSE, ?)',
    [dutyId, groupId, adminMemberId, now, now],
  );

  const res = await request(app).delete(`/groups/${groupId}/bazar/${dutyId}`).set('Authorization', `Bearer ${joiner.token}`);
  assert.equal(res.status, 403);

  const [rows] = await pool.query('SELECT id FROM bazar_duties WHERE id = ?', [dutyId]);
  assert.equal(rows.length, 1, 'an unauthorized delete must leave the duty intact');
});

test('GET /groups lists messes the caller owns or has joined, and nothing else', async () => {
  const app = createApp();
  const owner = await createTestUser();
  const stranger = await createTestUser();
  await bringGroupOnline(app, owner.token, { appAdminMemberId: randomUUID() });

  const ownerRes = await request(app).get('/groups').set('Authorization', `Bearer ${owner.token}`);
  const strangerRes = await request(app).get('/groups').set('Authorization', `Bearer ${stranger.token}`);

  assert.ok(ownerRes.body.groups.length >= 1);
  assert.equal(strangerRes.body.groups.filter((g) => ownerRes.body.groups.some((og) => og.id === g.id)).length, 0);
});
