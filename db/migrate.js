import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mysql from 'mysql2/promise';
import 'dotenv/config';

// Applies db/schema.sql in full. Every statement uses `CREATE TABLE IF NOT
// EXISTS`, so this is safe to re-run -- there's no migration ledger yet
// (fine at this stage; add one before the schema needs to *change* an
// existing column rather than just add new tables).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  const dbName = process.env.DB_NAME || 'mess_manager';
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4`);
  await connection.changeUser({ database: dbName });

  const sql = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await connection.query(sql);

  const masterEmails = (process.env.MASTER_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  for (const email of masterEmails) {
    await connection.query('INSERT IGNORE INTO master_admins (email) VALUES (?)', [email]);
  }

  console.log(`Schema applied to \`${dbName}\`. Master admins seeded: ${masterEmails.join(', ') || '(none)'}`);
  await connection.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
