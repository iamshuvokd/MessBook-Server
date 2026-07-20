import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLES, toSnakeRow, toCamelRow } from '../src/sync/tables.js';

function expectedSnake(camel) {
  return camel.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

test("every TABLES column's snake name matches the expected camelCase->snake_case conversion", () => {
  for (const [key, def] of Object.entries(TABLES)) {
    for (const col of def.columns) {
      assert.equal(col.snake, expectedSnake(col.camel), `${key}.${col.camel}`);
    }
  }
});

test("toSnakeRow/toCamelRow round-trips every table's full column set", () => {
  for (const [key, def] of Object.entries(TABLES)) {
    const camelRow = {};
    for (const col of def.columns) camelRow[col.camel] = `value_${col.camel}`;

    const snakeRow = toSnakeRow(key, camelRow);
    for (const col of def.columns) {
      assert.equal(snakeRow[col.snake], camelRow[col.camel], `${key}: ${col.snake} mismatch after toSnakeRow`);
    }
    assert.equal(Object.keys(snakeRow).length, def.columns.length, `${key}: unexpected extra/missing keys after toSnakeRow`);

    const roundTripped = toCamelRow(key, snakeRow);
    assert.deepEqual(roundTripped, camelRow, `${key}: round trip mismatch`);
  }
});

test('toSnakeRow ignores undefined fields instead of writing them through', () => {
  const partial = { id: 'x' }; // members has many more columns than this
  const snake = toSnakeRow('members', partial);
  assert.deepEqual(snake, { id: 'x' });
});

test('every table declares a primaryKey that references its own columns', () => {
  for (const [key, def] of Object.entries(TABLES)) {
    const camelNames = def.columns.map((c) => c.camel);
    for (const pk of def.primaryKey) {
      assert.ok(camelNames.includes(pk), `${key}: primaryKey '${pk}' not found among its own columns`);
    }
  }
});

test('every child (parent-scoped) table points at a real table', () => {
  const sqlTableNames = new Set(Object.values(TABLES).map((d) => d.table));
  for (const [key, def] of Object.entries(TABLES)) {
    if (!def.parent) continue;
    assert.ok(sqlTableNames.has(def.parent.table), `${key}: parent table '${def.parent.table}' not found among TABLES`);
  }
});
