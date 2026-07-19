import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, loadGroupContext } from '../middleware/auth.js';
import { blockIfExpired } from '../middleware/permissions.js';
import { TABLES, toSnakeRow, toCamelRow } from '../sync/tables.js';
import { broadcastDataChanged } from '../chat/socket.js';

export const syncRouter = Router();

syncRouter.use('/groups/:id/sync', requireAuth, loadGroupContext);

/**
 * Pull every row across every synced table that changed after `sinceMs`
 * (0 = full sync). The caller must already be a member of this group.
 */
syncRouter.post('/groups/:id/sync/pull', async (req, res) => {
  if (!req.membership) return res.status(403).json({ error: 'not_a_member' });
  let sinceMs = Number(req.body.sinceMs) || 0;
  // Safety net for clients whose clock ran ahead of the server: a cursor in
  // the server's future would make the incremental filter (`updated_at >
  // sinceMs`) skip rows written in the gap forever. Treat any future cursor
  // as a full pull so such a device self-recovers on its next sync, even on
  // an older build that stored a phone-clock cursor.
  if (sinceMs > Date.now()) sinceMs = 0;
  const groupId = req.params.id;

  const result = {};
  for (const [key, def] of Object.entries(TABLES)) {
    if (key === 'groups') {
      // The group's own row: not group-scoped (it IS the group), no
      // parent — matched directly by id instead of a group_id column.
      const [rows] = await pool.query(`SELECT * FROM \`${def.table}\` WHERE id = ?`, [groupId]);
      result[key] = rows.map((r) => toCamelRow(key, r));
    } else if (def.groupScoped) {
      const whereUpdated = def.noUpdatedAt ? '' : 'AND updated_at > ?';
      const params = def.noUpdatedAt ? [groupId] : [groupId, sinceMs];
      const [rows] = await pool.query(`SELECT * FROM \`${def.table}\` WHERE group_id = ? ${whereUpdated}`, params);
      result[key] = rows.map((r) => toCamelRow(key, r));
    } else if (def.parent) {
      // Child rows reach the group indirectly via their parent table; join
      // through it so a single group-scoped pull still covers them.
      const parentDef = TABLES[Object.keys(TABLES).find((k) => TABLES[k].table === def.parent.table)];
      const parentGroupCol = parentDef.groupScoped ? 'group_id' : null;
      if (parentGroupCol) {
        const [rows] = await pool.query(
          `SELECT c.* FROM \`${def.table}\` c JOIN \`${def.parent.table}\` p ON c.\`${def.parent.key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}\` = p.id WHERE p.group_id = ?`,
          [groupId],
        );
        result[key] = rows.map((r) => toCamelRow(key, r));
      } else {
        // Two hops (e.g. member_meal_routines -> members -> groups).
        const [rows] = await pool.query(
          `SELECT c.* FROM \`${def.table}\` c
           JOIN \`${def.parent.table}\` p ON c.\`${def.parent.key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}\` = p.id
           WHERE p.group_id = ?`,
          [groupId],
        );
        result[key] = rows.map((r) => toCamelRow(key, r));
      }
    }
  }

  // Tell the caller which member row IS them in this group, so their device
  // can resolve its own identity deterministically (which member's role /
  // permissions apply) instead of guessing — without this a member's device
  // with no locally-set identity falls back to acting as the App Admin.
  res.json({ serverTimeMs: Date.now(), myMemberId: req.membership.id, tables: result });
});

/**
 * Push local changes. Each table's rows are last-write-wins by
 * `updatedAt` against whatever's already stored; a row whose incoming
 * `updatedAt` is older than what's on the server is reported back as a
 * conflict (the client should re-pull and overwrite its local copy).
 * Tables without an `updatedAt` (months) always accept the push.
 */
syncRouter.post('/groups/:id/sync/push', blockIfExpired, async (req, res) => {
  if (!req.membership) return res.status(403).json({ error: 'not_a_member' });
  const changes = req.body.changes || {};
  const results = {};

  for (const [key, rows] of Object.entries(changes)) {
    const def = TABLES[key];
    if (!def || !Array.isArray(rows)) continue;
    results[key] = [];

    for (const camelRow of rows) {
      const snakeRow = toSnakeRow(key, camelRow);
      const pkWhere = def.primaryKey.map((k) => `\`${def.columns.find((c) => c.camel === k).snake}\` = ?`).join(' AND ');
      const pkValues = def.primaryKey.map((k) => camelRow[k]);

      const [existingRows] = await pool.query(`SELECT * FROM \`${def.table}\` WHERE ${pkWhere}`, pkValues);
      const existing = existingRows[0];

      if (existing && !def.noUpdatedAt && Number(existing.updated_at) > Number(camelRow.updatedAt)) {
        results[key].push({ id: pkValues.join(':'), status: 'conflict' });
        continue;
      }

      const columns = Object.keys(snakeRow);
      const placeholders = columns.map(() => '?').join(', ');
      const updateClause = columns.filter((c) => !def.primaryKey.some((k) => def.columns.find((dc) => dc.camel === k).snake === c))
        .map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');

      await pool.query(
        `INSERT INTO \`${def.table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updateClause || columns[0] + ' = VALUES(' + columns[0] + ')'}`,
        columns.map((c) => snakeRow[c]),
      );
      results[key].push({ id: pkValues.join(':'), status: 'accepted' });
    }
  }

  // Nudge any other device currently viewing this group to pull now instead
  // of waiting for its next periodic sync. Best-effort: a broadcast failure
  // (or nobody connected) must never fail the push itself.
  try {
    const changedTables = Object.entries(results)
      .filter(([, rows]) => rows.some((r) => r.status === 'accepted'))
      .map(([key]) => key);
    broadcastDataChanged(req.params.id, changedTables);
  } catch {
    // ignore
  }

  res.json({ serverTimeMs: Date.now(), results });
});
