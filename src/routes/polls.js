import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth, loadGroupContext } from '../middleware/auth.js';
import { requirePermission, hasPermission, blockIfExpired } from '../middleware/permissions.js';

export const pollsRouter = Router();
pollsRouter.use(requireAuth);

const createPollSchema = z.object({
  id: z.string().uuid(),
  date: z.number().int(),
  type: z.enum(['slots', 'count', 'menu']),
  title: z.string().nullable().optional(),
  options: z.array(z.string()).default([]),
  closeAt: z.number().int(),
  nonVoterPolicy: z.enum(['routine', 'pending', 'zero', 'repeatYesterday']).nullable().optional(),
});

function canCreatePoll(membership) {
  return hasPermission(membership, 'polls.create') || hasPermission(membership, 'polls.manage');
}

pollsRouter.post('/groups/:id/polls', loadGroupContext, blockIfExpired, async (req, res) => {
  if (!canCreatePoll(req.membership)) return res.status(403).json({ error: 'permission_denied' });
  const parsed = createPollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const p = parsed.data;

  await pool.query(
    `INSERT INTO meal_polls (id, group_id, date, type, title, options_json, close_at, created_by_member_id, non_voter_policy, closed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?)`,
    [p.id, req.params.id, p.date, p.type, p.title || null, p.options.length ? JSON.stringify(p.options) : null, p.closeAt, req.membership.id, p.nonVoterPolicy || null, Date.now()],
  );
  res.status(201).json({ id: p.id });
});

pollsRouter.get('/groups/:id/polls', loadGroupContext, async (req, res) => {
  if (!req.membership) return res.status(403).json({ error: 'not_a_member' });
  const params = [req.params.id];
  let where = 'group_id = ?';
  if (req.query.date) {
    where += ' AND date = ?';
    params.push(Number(req.query.date));
  }
  const [polls] = await pool.query(`SELECT * FROM meal_polls WHERE ${where} ORDER BY date DESC`, params);
  res.json({ polls });
});

const voteSchema = z.object({
  slotIds: z.array(z.string()).optional(),
  count: z.number().optional(),
  optionIndex: z.number().int().optional(),
});

pollsRouter.post('/polls/:pollId/vote', async (req, res) => {
  const [pollRows] = await pool.query('SELECT * FROM meal_polls WHERE id = ?', [req.params.pollId]);
  const poll = pollRows[0];
  if (!poll) return res.status(404).json({ error: 'poll_not_found' });
  if (poll.closed || Number(poll.close_at) < Date.now()) return res.status(409).json({ error: 'poll_closed' });

  const [members] = await pool.query('SELECT * FROM members WHERE group_id = ? AND user_id = ?', [poll.group_id, req.user.id]);
  const membership = members[0];
  if (!membership) return res.status(403).json({ error: 'not_a_member' });

  const parsed = voteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const value = {};
  if (parsed.data.slotIds) value.slotIds = parsed.data.slotIds;
  if (parsed.data.count !== undefined) value.count = parsed.data.count;
  if (parsed.data.optionIndex !== undefined) value.optionIndex = parsed.data.optionIndex;

  await pool.query(
    `INSERT INTO meal_poll_votes (poll_id, member_id, value_json, voted_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), voted_at = VALUES(voted_at)`,
    [poll.id, membership.id, JSON.stringify(value), Date.now()],
  );
  res.status(204).end();
});
