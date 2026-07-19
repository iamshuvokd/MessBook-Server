import { verifyAccessToken } from '../utils/jwt.js';
import { pool } from '../db.js';
import { config } from '../config.js';

/** Requires a valid access token; attaches `req.user = {id, email}`. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token' });
  }
  try {
    const payload = verifyAccessToken(header.slice('Bearer '.length));
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

/** Attaches `req.isMasterAdmin`. Call after requireAuth. */
export function checkMasterAdmin(req, res, next) {
  req.isMasterAdmin = config.masterAdminEmails.includes((req.user?.email || '').toLowerCase());
  next();
}

export function requireMasterAdmin(req, res, next) {
  checkMasterAdmin(req, res, () => {
    if (!req.isMasterAdmin) return res.status(403).json({ error: 'master_admin_only' });
    next();
  });
}

/**
 * Loads the caller's `members` row for the `:id` group in the URL and
 * attaches it as `req.membership` (null if they haven't joined). Also
 * attaches `req.group` (the group row) and 404s if the group doesn't exist.
 */
export async function loadGroupContext(req, res, next) {
  const groupId = req.params.id || req.params.groupId;
  const [groups] = await pool.query('SELECT * FROM `groups` WHERE id = ?', [groupId]);
  if (groups.length === 0) return res.status(404).json({ error: 'group_not_found' });
  req.group = groups[0];

  // Lazily flip an unpaid mess to 'expired' on next access rather than
  // running a cron job (same no-cron pattern used for poll close times).
  if (req.group.status === 'active' && req.group.paid_until) {
    const paidUntil = new Date(`${req.group.paid_until}T23:59:59`);
    if (paidUntil < new Date()) {
      req.group.status = 'expired';
      await pool.query('UPDATE `groups` SET status = ? WHERE id = ?', ['expired', groupId]);
    }
  }

  const [members] = await pool.query('SELECT * FROM members WHERE group_id = ? AND user_id = ?', [groupId, req.user.id]);
  req.membership = members[0] || null;
  next();
}
