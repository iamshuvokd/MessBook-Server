// Runs against a real MySQL instance (the local Docker dev stack, or the
// `mysql` service the CI workflow now provisions for the `test` job) — the
// generic push/pull last-write-wins engine in src/routes/sync.js is core
// correctness that a DB-free test can't actually exercise.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { signAccessToken } from '../src/utils/jwt.js';

// mysql2's pool keeps idle connections open, which otherwise leaves
// `node --test` hanging after every test has finished (it doesn't
// force-exit like some test runners do).
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

test('push then pull round-trips an expense through the group', async () => {
  const app = createApp();
  const user = await createTestUser();
  const { groupId } = await bringGroupOnline(app, user.token, { appAdminMemberId: randomUUID() });

  const now = Date.now();
  const categoryId = randomUUID();
  const expenseId = randomUUID();

  const pushRes = await request(app)
    .post(`/groups/${groupId}/sync/push`)
    .set('Authorization', `Bearer ${user.token}`)
    .send({
      changes: {
        categories: [{ id: categoryId, groupId, name: 'Bazar', isMealCategory: true, icon: 'shopping_cart', updatedAt: now }],
        expenses: [{ id: expenseId, groupId, amountPaisa: 5000, date: now, categoryId, deleted: false, updatedAt: now }],
      },
    });
  assert.equal(pushRes.status, 200);
  assert.equal(pushRes.body.results.expenses[0].status, 'accepted');

  const pullRes = await request(app)
    .post(`/groups/${groupId}/sync/pull`)
    .set('Authorization', `Bearer ${user.token}`)
    .send({ sinceMs: 0 });
  assert.equal(pullRes.status, 200);
  const pulledExpense = pullRes.body.tables.expenses.find((e) => e.id === expenseId);
  assert.ok(pulledExpense, 'the pushed expense must come back on pull');
  assert.equal(pulledExpense.amountPaisa, 5000);
});

test('a push carrying an older updatedAt than what is stored is rejected as a conflict, never applied', async () => {
  const app = createApp();
  const user = await createTestUser();
  const { groupId } = await bringGroupOnline(app, user.token, { appAdminMemberId: randomUUID() });

  const categoryId = randomUUID();
  const expenseId = randomUUID();
  const laterMs = Date.now();
  const earlierMs = laterMs - 100_000;

  await request(app)
    .post(`/groups/${groupId}/sync/push`)
    .set('Authorization', `Bearer ${user.token}`)
    .send({
      changes: {
        categories: [{ id: categoryId, groupId, name: 'Bazar', isMealCategory: true, icon: 'shopping_cart', updatedAt: laterMs }],
        expenses: [{ id: expenseId, groupId, amountPaisa: 5000, date: laterMs, categoryId, deleted: false, updatedAt: laterMs }],
      },
    });

  const conflictRes = await request(app)
    .post(`/groups/${groupId}/sync/push`)
    .set('Authorization', `Bearer ${user.token}`)
    .send({
      changes: {
        expenses: [{ id: expenseId, groupId, amountPaisa: 9999, date: earlierMs, categoryId, deleted: false, updatedAt: earlierMs }],
      },
    });
  assert.equal(conflictRes.body.results.expenses[0].status, 'conflict');

  const [rows] = await pool.query('SELECT amount_paisa FROM expenses WHERE id = ?', [expenseId]);
  assert.equal(rows[0].amount_paisa, 5000, 'the newer stored row must not be overwritten by an older push');
});

test('sync routes reject a caller who is not a member of the group', async () => {
  const app = createApp();
  const owner = await createTestUser();
  const outsider = await createTestUser();
  const { groupId } = await bringGroupOnline(app, owner.token, { appAdminMemberId: randomUUID() });

  const res = await request(app)
    .post(`/groups/${groupId}/sync/pull`)
    .set('Authorization', `Bearer ${outsider.token}`)
    .send({ sinceMs: 0 });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'not_a_member');
});

test('an unauthenticated request is rejected before ever reaching the group', async () => {
  const app = createApp();
  const res = await request(app).post(`/groups/${randomUUID()}/sync/pull`).send({ sinceMs: 0 });
  assert.equal(res.status, 401);
});
