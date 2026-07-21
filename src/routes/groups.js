import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth, loadGroupContext } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { generateInviteCode } from '../utils/inviteCode.js';
import { pushMemberJoined } from '../push/fcm.js';

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

const createGroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  type: z.string().default('mess'),
  currencySymbol: z.string().default('৳'),
  monthStartDay: z.number().int().min(1).max(28).default(1),
  mealEnabled: z.boolean().default(true),
  mealLedgerSeparate: z.boolean().default(false),
  defaultNonVoterPolicy: z.string().default('routine'),
  // The local id of the caller's own (App Admin) member row, if one
  // already exists offline. See note below on why this is linked here.
  appAdminMemberId: z.string().uuid().optional(),
  // The manager's real name, so the placeholder member row below isn't named
  // after the mess (which last-write-wins could otherwise make stick).
  appAdminName: z.string().min(1).optional(),
});

/**
 * "Bring mess online": registers a mess that already exists locally (same
 * id as the local Drift row) as owned by the caller, and mints an invite
 * code. The app follows this with a full sync/push of everything else.
 */
groupsRouter.post('/groups', async (req, res) => {
  const parsed = createGroupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const g = parsed.data;

  const [existing] = await pool.query('SELECT id FROM `groups` WHERE id = ?', [g.id]);
  if (existing.length > 0) return res.status(409).json({ error: 'group_already_online' });

  let inviteCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    inviteCode = generateInviteCode();
    const [clash] = await pool.query('SELECT invite_code FROM `groups` WHERE invite_code = ?', [inviteCode]);
    if (clash.length === 0) break;
  }

  const now = Date.now();
  await pool.query(
    `INSERT INTO \`groups\` (id, owner_user_id, invite_code, name, type, currency_symbol, month_start_day,
       meal_enabled, meal_ledger_separate, default_non_voter_policy, archived, status, paid_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, 'active', NULL, ?, ?)`,
    [g.id, req.user.id, inviteCode, g.name, g.type, g.currencySymbol, g.monthStartDay, g.mealEnabled, g.mealLedgerSeparate, g.defaultNonVoterPolicy, now, now],
  );

  // Bringing a mess online only registers the *group* — without this, the
  // caller (who just became its owner) still isn't a *member* of it
  // server-side, and the very next call they make (the sync push that's
  // supposed to upload their local data, including their own member row)
  // would 403 as "not_a_member" before ever getting the chance to. Insert
  // a placeholder member row now, linked to their account; the sync push
  // that follows overwrites its name/phone/etc with the real local data
  // (user_id isn't part of the generic sync column set, so that push never
  // clears this link).
  if (g.appAdminMemberId) {
    await pool.query(
      // updated_at = 1 (effectively "oldest possible") so the caller's very
      // next sync push — carrying their real member row — always wins the
      // last-write-wins comparison and overwrites this placeholder, even on
      // an older client that doesn't send appAdminName. Without this the
      // placeholder (stamped "now") would beat the real row and the mess
      // name would stick as the manager's name.
      `INSERT INTO members (id, group_id, user_id, name, join_date, active, role, permissions, updated_at)
       VALUES (?, ?, ?, ?, ?, TRUE, 'appAdmin', '', 1)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), name = VALUES(name)`,
      [g.appAdminMemberId, g.id, req.user.id, g.appAdminName || g.name, now],
    );
  }

  res.status(201).json({ id: g.id, inviteCode });
});

/**
 * Looks up an invite code before actually joining, so the app can offer
 * "is this you?" against members already created offline (e.g. the App
 * Admin added "Rahim" locally before bringing the mess online) instead of
 * always creating a duplicate member row.
 */
groupsRouter.get('/groups/join/:code/members', async (req, res) => {
  const code = req.params.code.toUpperCase();
  const [groups] = await pool.query('SELECT id, name FROM `groups` WHERE invite_code = ?', [code]);
  const group = groups[0];
  if (!group) return res.status(404).json({ error: 'invalid_code' });

  const [members] = await pool.query(
    'SELECT id, name FROM members WHERE group_id = ? AND user_id IS NULL AND active = TRUE ORDER BY join_date ASC',
    [group.id],
  );
  res.json({ groupId: group.id, groupName: group.name, members });
});

const joinSchema = z.object({
  code: z.string().min(1),
  memberName: z.string().min(1).optional(),
  existingMemberId: z.string().uuid().optional(),
});

groupsRouter.post('/groups/join', async (req, res) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { code, memberName, existingMemberId } = parsed.data;

  const [groups] = await pool.query('SELECT * FROM `groups` WHERE invite_code = ?', [code.toUpperCase()]);
  const group = groups[0];
  if (!group) return res.status(404).json({ error: 'invalid_code' });

  const [already] = await pool.query('SELECT * FROM members WHERE group_id = ? AND user_id = ?', [group.id, req.user.id]);
  if (already.length > 0) return res.json({ groupId: group.id, memberId: already[0].id });

  if (existingMemberId) {
    const [target] = await pool.query('SELECT * FROM members WHERE id = ? AND group_id = ? AND user_id IS NULL', [existingMemberId, group.id]);
    if (target.length === 0) return res.status(404).json({ error: 'member_not_found_or_claimed' });
    await pool.query('UPDATE members SET user_id = ?, updated_at = ? WHERE id = ?', [req.user.id, Date.now(), existingMemberId]);
    pushMemberJoined({ groupId: group.id, groupName: group.name, newMemberName: target[0].name, excludeUserId: req.user.id }).catch(() => {});
    return res.json({ groupId: group.id, memberId: existingMemberId });
  }

  if (!memberName) return res.status(400).json({ error: 'member_name_required' });
  const { v4: uuid } = await import('uuid');
  const memberId = uuid();
  const now = Date.now();
  await pool.query(
    'INSERT INTO members (id, group_id, user_id, name, join_date, active, role, permissions, updated_at) VALUES (?, ?, ?, ?, ?, TRUE, ?, ?, ?)',
    [memberId, group.id, req.user.id, memberName, now, 'member', '', now],
  );
  pushMemberJoined({ groupId: group.id, groupName: group.name, newMemberName: memberName, excludeUserId: req.user.id }).catch(() => {});
  res.json({ groupId: group.id, memberId });
});

groupsRouter.get('/groups', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT DISTINCT g.* FROM \`groups\` g
     LEFT JOIN members m ON m.group_id = g.id AND m.user_id = ?
     WHERE g.owner_user_id = ? OR m.user_id = ?`,
    [req.user.id, req.user.id, req.user.id],
  );
  res.json({ groups: rows });
});

const roleSchema = z.object({
  role: z.enum(['appAdmin', 'subAdmin', 'member']),
  permissions: z.array(z.string()).default([]),
});

// Role assignment is App-Admin-only and non-delegable, mirroring the app.
groupsRouter.patch('/groups/:id/members/:mid/role', loadGroupContext, async (req, res) => {
  if (req.membership?.role !== 'appAdmin') return res.status(403).json({ error: 'app_admin_only' });
  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const permissions = parsed.data.role === 'subAdmin' ? parsed.data.permissions.join(',') : '';
  await pool.query('UPDATE members SET role = ?, permissions = ?, updated_at = ? WHERE id = ? AND group_id = ?', [
    parsed.data.role, permissions, Date.now(), req.params.mid, req.params.id,
  ]);
  res.status(204).end();
});

/**
 * Hands the App Admin role to another member of the mess, demoting the
 * caller to a plain member in the same request. Also moves `groups`
 * ownership so the new admin — not the old one — is who future server-side
 * checks (and the master admin dashboard) treat as responsible for this
 * mess. The target must already be a linked (joined) member; ownership
 * can't be handed to someone who hasn't joined online yet.
 */
groupsRouter.post('/groups/:id/transfer-ownership', loadGroupContext, async (req, res) => {
  if (req.membership?.role !== 'appAdmin') return res.status(403).json({ error: 'app_admin_only' });
  const parsed = z.object({ newOwnerMemberId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const { id: groupId } = req.params;
  const { newOwnerMemberId } = parsed.data;
  const [targets] = await pool.query(
    'SELECT * FROM members WHERE id = ? AND group_id = ? AND active = TRUE AND user_id IS NOT NULL',
    [newOwnerMemberId, groupId],
  );
  const target = targets[0];
  if (!target) return res.status(404).json({ error: 'target_not_found_or_not_joined' });

  const now = Date.now();
  await pool.query("UPDATE members SET role = 'appAdmin', permissions = '', updated_at = ? WHERE id = ?", [now, newOwnerMemberId]);
  await pool.query("UPDATE members SET role = 'member', permissions = '', updated_at = ? WHERE id = ?", [now, req.membership.id]);
  await pool.query('UPDATE `groups` SET owner_user_id = ?, updated_at = ? WHERE id = ?', [target.user_id, now, groupId]);
  res.status(204).end();
});

// A member with any real mess history (meals, money, polls, chat) is never
// hard-deleted — only deactivated — so past records always still resolve to
// a real name. Mirrors the equivalent check in the client's
// MembersRepository.hasHistory.
async function memberHasHistory(memberId) {
  const checks = await Promise.all([
    pool.query('SELECT 1 FROM expense_payers WHERE member_id = ? LIMIT 1', [memberId]),
    pool.query('SELECT 1 FROM expense_splits WHERE member_id = ? LIMIT 1', [memberId]),
    pool.query('SELECT 1 FROM meals WHERE member_id = ? LIMIT 1', [memberId]),
    pool.query('SELECT 1 FROM deposits WHERE member_id = ? LIMIT 1', [memberId]),
    pool.query('SELECT 1 FROM settlements WHERE from_member_id = ? OR to_member_id = ? LIMIT 1', [memberId, memberId]),
    pool.query('SELECT 1 FROM meal_polls WHERE created_by_member_id = ? LIMIT 1', [memberId]),
    pool.query('SELECT 1 FROM meal_poll_votes WHERE member_id = ? LIMIT 1', [memberId]),
    pool.query('SELECT 1 FROM chat_messages WHERE member_id = ? LIMIT 1', [memberId]),
  ]);
  return checks.some(([rows]) => rows.length > 0);
}

// A bazar duty is a plain scheduling row with no dependants, so it hard
// deletes. The server side is required: sync only ever upserts, so a purely
// local delete would come straight back on the member's next pull.
groupsRouter.delete('/groups/:id/bazar/:dutyId', loadGroupContext, requirePermission('meals.manage'), async (req, res) => {
  const { id: groupId, dutyId } = req.params;
  await pool.query('DELETE FROM bazar_duties WHERE id = ? AND group_id = ?', [dutyId, groupId]);
  res.status(204).end();
});

groupsRouter.delete('/groups/:id/members/:mid', loadGroupContext, requirePermission('members.manage'), async (req, res) => {
  const { id: groupId, mid: memberId } = req.params;
  if (await memberHasHistory(memberId)) {
    await pool.query('UPDATE members SET active = FALSE, leave_date = ?, updated_at = ? WHERE id = ? AND group_id = ?', [
      Date.now(), Date.now(), memberId, groupId,
    ]);
    return res.status(204).end();
  }
  await pool.query('DELETE FROM member_meal_routines WHERE member_id = ?', [memberId]);
  await pool.query('DELETE FROM meal_leaves WHERE member_id = ?', [memberId]);
  await pool.query('DELETE FROM members WHERE id = ? AND group_id = ?', [memberId, groupId]);
  res.status(204).end();
});
