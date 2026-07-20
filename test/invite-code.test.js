import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateInviteCode } from '../src/utils/inviteCode.js';

test('generates a code matching the MESS-XXXX format with no ambiguous characters', () => {
  const code = generateInviteCode();
  assert.match(code, /^MESS-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
});

test('never contains visually-ambiguous characters (0, O, 1, I, L)', () => {
  for (let i = 0; i < 200; i++) {
    assert.doesNotMatch(generateInviteCode(), /[0O1IL]/);
  }
});

test('generates codes with reasonable entropy (not the same code every time)', () => {
  const codes = new Set();
  for (let i = 0; i < 500; i++) codes.add(generateInviteCode());
  // 31^4 ≈ 923k possibilities; 500 draws should come back almost entirely
  // distinct — a healthy-majority check guards against a broken RNG (e.g.
  // an index that always resolves to the same character).
  assert.ok(codes.size > 480, `expected mostly-unique codes, got ${codes.size}/500 distinct`);
});
