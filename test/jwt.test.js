import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiryTimestamp,
} from '../src/utils/jwt.js';
import { config } from '../src/config.js';

test('signAccessToken/verifyAccessToken round-trips the user id and email', () => {
  const token = signAccessToken({ id: 'user-1', email: 'a@example.com' });
  const payload = verifyAccessToken(token);
  assert.equal(payload.sub, 'user-1');
  assert.equal(payload.email, 'a@example.com');
});

test('verifyAccessToken rejects a token signed with a different secret', () => {
  const tampered = jwt.sign({ sub: 'user-1' }, 'wrong-secret', { expiresIn: '15m' });
  assert.throws(() => verifyAccessToken(tampered));
});

test('verifyAccessToken rejects an expired token', () => {
  const expired = jwt.sign({ sub: 'user-1' }, config.jwt.secret, { expiresIn: -10 });
  assert.throws(() => verifyAccessToken(expired), /jwt expired/);
});

test('verifyAccessToken rejects a token whose payload was tampered with after signing', () => {
  const token = signAccessToken({ id: 'user-1', email: 'a@example.com' });
  const [header, , signature] = token.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'attacker', email: 'evil@example.com' })).toString(
    'base64url',
  );
  const tampered = `${header}.${tamperedPayload}.${signature}`;
  assert.throws(() => verifyAccessToken(tampered));
});

test('generateRefreshToken produces distinct, sufficiently long tokens', () => {
  const a = generateRefreshToken();
  const b = generateRefreshToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
});

test('hashRefreshToken is deterministic and differs across distinct inputs', () => {
  const token = generateRefreshToken();
  assert.equal(hashRefreshToken(token), hashRefreshToken(token));
  assert.notEqual(hashRefreshToken(token), hashRefreshToken(generateRefreshToken()));
});

test('refreshExpiryTimestamp lands roughly refreshTtlDays in the future', () => {
  const before = Date.now();
  const expiry = refreshExpiryTimestamp();
  const expectedMs = config.jwt.refreshTtlDays * 24 * 60 * 60 * 1000;
  assert.ok(expiry > before, 'expiry must be in the future');
  assert.ok(Math.abs(expiry - before - expectedMs) < 5000, 'expiry should land ~refreshTtlDays away');
});
