import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwt.secret, { expiresIn: config.jwt.accessTtl });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.secret);
}

export function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function refreshExpiryTimestamp() {
  return Date.now() + config.jwt.refreshTtlDays * 24 * 60 * 60 * 1000;
}
