import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';

test('GET /health returns ok without touching the database', async () => {
  const app = createApp();
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('protected routes reject requests with no token', async () => {
  const app = createApp();
  const res = await request(app).get('/me');
  assert.equal(res.status, 401);
});
