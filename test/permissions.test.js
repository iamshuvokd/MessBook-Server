import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasPermission, requirePermission, blockIfExpired, PERMISSIONS } from '../src/middleware/permissions.js';

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

test('hasPermission: App Admin implicitly holds every permission', () => {
  for (const p of PERMISSIONS) {
    assert.equal(hasPermission({ role: 'appAdmin', permissions: '' }, p), true);
  }
});

test('hasPermission: a plain member holds nothing', () => {
  for (const p of PERMISSIONS) {
    assert.equal(hasPermission({ role: 'member', permissions: '' }, p), false);
  }
});

test('hasPermission: a sub-admin only holds explicitly granted permissions', () => {
  const membership = { role: 'subAdmin', permissions: 'meals.manage,polls.create' };
  assert.equal(hasPermission(membership, 'meals.manage'), true);
  assert.equal(hasPermission(membership, 'polls.create'), true);
  assert.equal(hasPermission(membership, 'money.manage'), false);
});

test('hasPermission: null membership (not a member of this group) holds nothing', () => {
  assert.equal(hasPermission(null, 'meals.manage'), false);
});

test('requirePermission: 403s with not_a_member when there is no membership', () => {
  const mw = requirePermission('meals.manage');
  const res = mockRes();
  let nextCalled = false;
  mw({ membership: null }, res, () => {
    nextCalled = true;
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'not_a_member');
  assert.equal(nextCalled, false);
});

test('requirePermission: 403s with permission_denied when the membership lacks the permission', () => {
  const mw = requirePermission('money.manage');
  const res = mockRes();
  let nextCalled = false;
  mw({ membership: { role: 'member', permissions: '' } }, res, () => {
    nextCalled = true;
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'permission_denied');
  assert.equal(res.body.required, 'money.manage');
  assert.equal(nextCalled, false);
});

test('requirePermission: calls next() when the membership holds the permission', () => {
  const mw = requirePermission('money.manage');
  const res = mockRes();
  let nextCalled = false;
  mw({ membership: { role: 'appAdmin', permissions: '' } }, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('blockIfExpired: GET requests always pass through regardless of status', () => {
  const res = mockRes();
  let nextCalled = false;
  blockIfExpired({ method: 'GET', group: { status: 'expired' } }, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test('blockIfExpired: a non-GET request on an active group passes through', () => {
  const res = mockRes();
  let nextCalled = false;
  blockIfExpired({ method: 'POST', group: { status: 'active' } }, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test('blockIfExpired: a non-GET request on an expired/disabled group is blocked with 402', () => {
  for (const status of ['expired', 'disabled']) {
    const res = mockRes();
    let nextCalled = false;
    blockIfExpired({ method: 'POST', group: { status } }, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 402);
    assert.equal(res.body.error, 'subscription_inactive');
    assert.equal(res.body.status, status);
    assert.equal(nextCalled, false);
  }
});
