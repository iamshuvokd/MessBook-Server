// Deleting a whole mess is the most destructive thing the API can do, so
// these pin down both halves: that only the App Admin can do it, and that
// when it happens nothing is left orphaned behind. Real MySQL — the point
// is the actual cascade/FK behaviour, which a fake would not exercise.
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
  const email = `${id}@del.local`;
  await pool.query('INSERT INTO users (id, google_sub, email, created_at) VALUES (?,?,?,?)', [id, id, email, Date.now()]);
  return { id, email, token: signAccessToken({ id, email }) };
}

/**
 * A mess with a row in every group-scoped table, so a delete that misses
 * one of them fails loudly instead of passing on an empty database.
 */
async function messWithFullHistory(app) {
  const owner = await createUser();
  const groupId = randomUUID();
  const adminMemberId = randomUUID();
  const created = await request(app)
    .post('/groups')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ id: groupId, name: 'Doomed Mess', appAdminMemberId: adminMemberId, appAdminName: 'Owner' });
  assert.equal(created.status, 201);

  const member = await createUser();
  const joined = await request(app)
    .post('/groups/join')
    .set('Authorization', `Bearer ${member.token}`)
    .send({ code: created.body.inviteCode, memberName: 'Plain Member' });
  assert.equal(joined.status, 200);

  const now = Date.now();
  const categoryId = randomUUID();
  const expenseId = randomUUID();
  const pollId = randomUUID();
  const slotId = randomUUID();

  await pool.query('INSERT INTO categories (id, group_id, name, is_meal_category, icon, updated_at) VALUES (?,?,?,?,?,?)',
    [categoryId, groupId, 'Bazar', true, 'cart', now]);
  await pool.query(
    'INSERT INTO expenses (id, group_id, amount_paisa, date, category_id, updated_at) VALUES (?,?,?,?,?,?)',
    [expenseId, groupId, 55000, now, categoryId, now]);
  await pool.query('INSERT INTO expense_payers (expense_id, member_id, amount_paid_paisa) VALUES (?,?,?)',
    [expenseId, adminMemberId, 55000]);
  await pool.query('INSERT INTO expense_splits (expense_id, member_id, amount_paisa, split_type) VALUES (?,?,?,?)',
    [expenseId, joined.body.memberId, 55000, 'meal']);
  await pool.query('INSERT INTO meals (id, group_id, member_id, date, count, guest_count, updated_at) VALUES (?,?,?,?,?,?,?)',
    [randomUUID(), groupId, adminMemberId, now, 2.5, 0, now]);
  await pool.query('INSERT INTO deposits (id, group_id, member_id, amount_paisa, date, updated_at) VALUES (?,?,?,?,?,?)',
    [randomUUID(), groupId, adminMemberId, 180000, now, now]);
  await pool.query(
    'INSERT INTO settlements (id, group_id, from_member_id, to_member_id, amount_paisa, date, updated_at) VALUES (?,?,?,?,?,?,?)',
    [randomUUID(), groupId, joined.body.memberId, adminMemberId, 5000, now, now]);
  await pool.query('INSERT INTO meal_slots (id, group_id, name, weight, sort_order, active, updated_at) VALUES (?,?,?,?,?,?,?)',
    [slotId, groupId, 'Lunch', 1, 0, true, now]);
  await pool.query('INSERT INTO member_meal_routines (id, member_id, slot_id, weekday, enabled, updated_at) VALUES (?,?,?,?,?,?)',
    [randomUUID(), adminMemberId, slotId, 1, true, now]);
  await pool.query('INSERT INTO meal_leaves (id, member_id, from_date, to_date, updated_at) VALUES (?,?,?,?,?)',
    [randomUUID(), adminMemberId, now, now + 1000, now]);
  await pool.query('INSERT INTO bazar_duties (id, group_id, member_id, date, done, updated_at) VALUES (?,?,?,?,?,?)',
    [randomUUID(), groupId, adminMemberId, now, false, now]);
  await pool.query(
    'INSERT INTO meal_polls (id, group_id, date, type, title, close_at, created_by_member_id, closed, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [pollId, groupId, now, 'count', 'Dinner?', now + 3600000, adminMemberId, false, now]);
  await pool.query('INSERT INTO meal_poll_votes (poll_id, member_id, value_json, voted_at) VALUES (?,?,?,?)',
    [pollId, adminMemberId, JSON.stringify({ count: 1 }), now]);
  await pool.query('INSERT INTO chat_messages (id, group_id, member_id, text, created_at) VALUES (?,?,?,?,?)',
    [randomUUID(), groupId, adminMemberId, 'hello', now]);

  return { owner, groupId, member, memberId: joined.body.memberId, adminMemberId, expenseId, pollId };
}

const del = (app, groupId, token) =>
  request(app).delete(`/groups/${groupId}`).set('Authorization', `Bearer ${token}`);

test('the App Admin can delete their mess, and nothing is left behind', async () => {
  const app = createApp();
  const { owner, groupId, expenseId, pollId, adminMemberId } = await messWithFullHistory(app);

  const res = await del(app, groupId, owner.token);
  assert.equal(res.status, 204);

  const [groups] = await pool.query('SELECT 1 FROM `groups` WHERE id = ?', [groupId]);
  assert.equal(groups.length, 0, 'the mess row itself must be gone');

  // Every group-scoped table.
  for (const table of [
    'members', 'categories', 'expenses', 'meals', 'deposits', 'settlements',
    'months', 'recurring_rules', 'meal_slots', 'bazar_duties', 'meal_polls', 'chat_messages',
  ]) {
    const [rows] = await pool.query(`SELECT 1 FROM \`${table}\` WHERE group_id = ?`, [groupId]);
    assert.equal(rows.length, 0, `${table} still has rows for the deleted mess`);
  }

  // Child tables have no group_id, so they are the ones most likely to be
  // silently orphaned by a delete that only clears the obvious tables.
  const [payers] = await pool.query('SELECT 1 FROM expense_payers WHERE expense_id = ?', [expenseId]);
  assert.equal(payers.length, 0, 'orphaned expense_payers');
  const [splits] = await pool.query('SELECT 1 FROM expense_splits WHERE expense_id = ?', [expenseId]);
  assert.equal(splits.length, 0, 'orphaned expense_splits');
  const [votes] = await pool.query('SELECT 1 FROM meal_poll_votes WHERE poll_id = ?', [pollId]);
  assert.equal(votes.length, 0, 'orphaned meal_poll_votes');
  const [routines] = await pool.query('SELECT 1 FROM member_meal_routines WHERE member_id = ?', [adminMemberId]);
  assert.equal(routines.length, 0, 'orphaned member_meal_routines');
  const [leaves] = await pool.query('SELECT 1 FROM meal_leaves WHERE member_id = ?', [adminMemberId]);
  assert.equal(leaves.length, 0, 'orphaned meal_leaves');
});

test('a plain member CANNOT delete the mess', async () => {
  const app = createApp();
  const { groupId, member } = await messWithFullHistory(app);

  const res = await del(app, groupId, member.token);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'app_admin_only');

  const [rows] = await pool.query('SELECT 1 FROM `groups` WHERE id = ?', [groupId]);
  assert.equal(rows.length, 1, 'the mess must survive a non-admin delete attempt');
});

test('a sub-admin with every permission still cannot delete the mess', async () => {
  const app = createApp();
  const { owner, groupId, member, memberId } = await messWithFullHistory(app);

  // Deleting the whole mess is deliberately NOT delegable: it is not one of
  // the grantable permissions, so even a fully-trusted sub-admin is refused.
  await request(app)
    .patch(`/groups/${groupId}/members/${memberId}/role`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ role: 'subAdmin', permissions: ['meals.manage', 'members.manage', 'money.manage', 'expenses.manage'] });

  const res = await del(app, groupId, member.token);
  assert.equal(res.status, 403);

  const [rows] = await pool.query('SELECT 1 FROM `groups` WHERE id = ?', [groupId]);
  assert.equal(rows.length, 1);
});

test('an outsider cannot delete someone else\'s mess', async () => {
  const app = createApp();
  const { groupId } = await messWithFullHistory(app);
  const outsider = await createUser();

  const res = await del(app, groupId, outsider.token);
  assert.equal(res.status, 403);

  const [rows] = await pool.query('SELECT 1 FROM `groups` WHERE id = ?', [groupId]);
  assert.equal(rows.length, 1);
});

test('an unauthenticated delete is rejected', async () => {
  const app = createApp();
  const { groupId } = await messWithFullHistory(app);

  const res = await request(app).delete(`/groups/${groupId}`);
  assert.equal(res.status, 401);

  const [rows] = await pool.query('SELECT 1 FROM `groups` WHERE id = ?', [groupId]);
  assert.equal(rows.length, 1);
});
