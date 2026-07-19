import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth, requireMasterAdmin } from '../middleware/auth.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireMasterAdmin);

/** Every mess, with owner + active member count, for the dashboard's list view. */
adminRouter.get('/admin/groups', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT g.id, g.name, g.type, g.invite_code AS inviteCode, g.status, g.paid_until AS paidUntil,
            g.archived, g.created_at AS createdAt, g.updated_at AS updatedAt,
            u.email AS ownerEmail, u.name AS ownerName,
            (SELECT COUNT(*) FROM members m WHERE m.group_id = g.id AND m.active = TRUE) AS memberCount
     FROM \`groups\` g
     LEFT JOIN users u ON u.id = g.owner_user_id
     ORDER BY g.created_at DESC`,
  );
  res.json({ groups: rows });
});

const updateSchema = z.object({
  status: z.enum(['active', 'expired', 'disabled']).optional(),
  paidUntil: z.string().date().nullable().optional(), // 'YYYY-MM-DD', or null to clear
});

/**
 * Activate/deactivate a mess and/or set how long it's paid through. This is
 * the entire "billing system": the buyer pays the Master Admin directly
 * (outside the app), who then extends `paidUntil` here — `loadGroupContext`
 * lazily flips a lapsed mess to 'expired' server-side on its next request.
 */
adminRouter.patch('/admin/groups/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const { status, paidUntil } = parsed.data;
  if (status === undefined && paidUntil === undefined) return res.status(400).json({ error: 'nothing_to_update' });

  const sets = ['updated_at = ?'];
  const params = [Date.now()];
  if (status !== undefined) {
    sets.push('status = ?');
    params.push(status);
  }
  if (paidUntil !== undefined) {
    sets.push('paid_until = ?');
    params.push(paidUntil);
  }
  params.push(req.params.id);

  const [result] = await pool.query(`UPDATE \`groups\` SET ${sets.join(', ')} WHERE id = ?`, params);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'group_not_found' });
  res.status(204).end();
});
