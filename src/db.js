import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
  // mysql2 returns BOOLEAN/TINYINT(1) columns as raw JS numbers (0/1) by
  // default, not real booleans -- every synced bool column (active,
  // mealEnabled, archived, closed, ...) would arrive at the app as an int
  // and fail Drift's `as bool` cast in fromJson. This is the standard fix:
  // only single-byte TINYINT columns (i.e. actual BOOLEAN columns) get
  // coerced; every other integer type passes through untouched.
  typeCast: (field, next) => {
    if (field.type === 'TINY' && field.length === 1) {
      return field.string() === '1';
    }
    return next();
  },
});

/** Runs [fn] inside a transaction, committing on success and rolling back on error. */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
