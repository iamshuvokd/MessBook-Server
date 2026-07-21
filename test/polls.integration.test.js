// Real-MySQL integration tests for the poll routes in src/routes/polls.js —
// focused on the role-gated DELETE. See sync.integration.test.js's header
// for why these need a real DB.
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
  const email = `${id}@test.local`;
  await pool.query('INSERT INTO users (id, google_sub, email, created_at) VALUES (?,?,?,?)', [id, id, email, Date.now()]);
  return { id, email, token: signAccessToken({ id, email }) };
}

async function bringOnline(app, token, appAdminMemberId) {
  const groupId = randomUUID();
  const res = await request(app)
    .post('/groups')
    .set('Authorization', `Bearer ${token}`)
    .send({ id: groupId, name: 'Poll Mess', appAdminMemberId, appAdminName: 'Admin' });
  assert.equal(res.status, 201);
  return { groupId, inviteCode: res.body.inviteCode };
}

async function joinMember(app, inviteCode, name) {
  const user = await createUser();
  const res = await request(app).post('/groups/join').set('Authorization', `Bearer ${user.token}`).send({ code: inviteCode, memberName: name });
  assert.equal(res.status, 200);
  return { user, memberId: res.body.memberId };
}

async function seedPollWithVote(groupId, createdByMemberId, voterMemberId) {
  const pollId = randomUUID();
  const now = Date.now();
  await pool.query(
    `INSERT INTO meal_polls (id, group_id, date, type, close_at, created_by_member_id, closed, updated_at)
     VALUES (?, ?, ?, 'count', ?, ?, FALSE, ?)`,
    [pollId, groupId, now, now + 3_600_000, createdByMemberId, now],
  );
  await pool.query('INSERT INTO meal_poll_votes (poll_id, member_id, value_json, voted_at) VALUES (?, ?, ?, ?)', [
    pollId,
    voterMemberId,
    JSON.stringify({ count: 2 }),
    now,
  ]);
  return pollId;
}

test('App Admin can delete a poll; the poll and its votes (cascade) are gone', async () => {
  const app = createApp();
  const owner = await createUser();
  const adminMemberId = randomUUID();
  const { groupId } = await bringOnline(app, owner.token, adminMemberId);
  const pollId = await seedPollWithVote(groupId, adminMemberId, adminMemberId);

  const res = await request(app).delete(`/groups/${groupId}/polls/${pollId}`).set('Authorization', `Bearer ${owner.token}`);
  assert.equal(res.status, 204);

  const [polls] = await pool.query('SELECT id FROM meal_polls WHERE id = ?', [pollId]);
  const [votes] = await pool.query('SELECT poll_id FROM meal_poll_votes WHERE poll_id = ?', [pollId]);
  assert.equal(polls.length, 0, 'poll must be gone');
  assert.equal(votes.length, 0, 'votes must be cascade-deleted');
});

test('a plain member (no polls.manage) is forbidden from deleting a poll', async () => {
  const app = createApp();
  const owner = await createUser();
  const adminMemberId = randomUUID();
  const { groupId, inviteCode } = await bringOnline(app, owner.token, adminMemberId);
  const member = await joinMember(app, inviteCode, 'Plain Member');
  const pollId = await seedPollWithVote(groupId, adminMemberId, member.memberId);

  const res = await request(app).delete(`/groups/${groupId}/polls/${pollId}`).set('Authorization', `Bearer ${member.user.token}`);
  assert.equal(res.status, 403);

  const [polls] = await pool.query('SELECT id FROM meal_polls WHERE id = ?', [pollId]);
  assert.equal(polls.length, 1, 'the poll must survive an unauthorized delete');
});

test('a sub-admin granted polls.manage can delete a poll', async () => {
  const app = createApp();
  const owner = await createUser();
  const adminMemberId = randomUUID();
  const { groupId, inviteCode } = await bringOnline(app, owner.token, adminMemberId);
  const sub = await joinMember(app, inviteCode, 'Sub Admin');
  await request(app)
    .patch(`/groups/${groupId}/members/${sub.memberId}/role`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ role: 'subAdmin', permissions: ['polls.manage'] });
  const pollId = await seedPollWithVote(groupId, adminMemberId, sub.memberId);

  const res = await request(app).delete(`/groups/${groupId}/polls/${pollId}`).set('Authorization', `Bearer ${sub.user.token}`);
  assert.equal(res.status, 204);
});

test('pushing a brand-new open poll via sync is accepted and stored (poll-created path is safe with FCM off)', async () => {
  const app = createApp();
  const owner = await createUser();
  const adminMemberId = randomUUID();
  const { groupId } = await bringOnline(app, owner.token, adminMemberId);

  const now = Date.now();
  const pollId = randomUUID();
  const res = await request(app)
    .post(`/groups/${groupId}/sync/push`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({
      changes: {
        mealPolls: [
          { id: pollId, groupId, date: now, type: 'count', title: 'Dinner tonight?', closeAt: now + 3_600_000, createdByMemberId: adminMemberId, closed: false, updatedAt: now },
        ],
      },
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.results.mealPolls[0].status, 'accepted');

  const [rows] = await pool.query('SELECT closed FROM meal_polls WHERE id = ?', [pollId]);
  assert.equal(rows.length, 1);
});

test('a non-member cannot delete a poll in a group they do not belong to', async () => {
  const app = createApp();
  const owner = await createUser();
  const adminMemberId = randomUUID();
  const { groupId } = await bringOnline(app, owner.token, adminMemberId);
  const pollId = await seedPollWithVote(groupId, adminMemberId, adminMemberId);

  const outsider = await createUser();
  const res = await request(app).delete(`/groups/${groupId}/polls/${pollId}`).set('Authorization', `Bearer ${outsider.token}`);
  assert.equal(res.status, 403);
});
