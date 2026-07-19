// Mirrors lib/domain/models/member_permission.dart exactly -- keep in sync.
export const PERMISSIONS = [
  'meals.manage',
  'polls.create',
  'polls.manage',
  'expenses.manage',
  'money.manage',
  'members.manage',
];

export function hasPermission(membership, permission) {
  if (!membership) return false;
  if (membership.role === 'appAdmin') return true;
  if (membership.role !== 'subAdmin') return false;
  return (membership.permissions || '').split(',').includes(permission);
}

/** Requires `req.membership` (set by loadGroupContext) to hold [permission]. */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.membership) return res.status(403).json({ error: 'not_a_member' });
    if (!hasPermission(req.membership, permission)) {
      return res.status(403).json({ error: 'permission_denied', required: permission });
    }
    next();
  };
}

/**
 * Blocks writes once a mess's subscription has lapsed (user decision: an
 * expired mess goes read-only, data intact, until the Master Admin extends
 * it). Read (GET) requests always pass through.
 */
export function blockIfExpired(req, res, next) {
  if (req.method === 'GET') return next();
  if (req.group?.status !== 'active') {
    return res.status(402).json({ error: 'subscription_inactive', status: req.group?.status });
  }
  next();
}
