import crypto from 'node:crypto';
import type { Role } from '../shared/protocol.ts';
import { stmt, type UserRow } from './db.ts';

export const SESSION_COOKIE = 'ss_session';
export const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export interface SessionUser {
  id: number;
  name: string;
  role: Role;
  roomCode: string;
}

export function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(secret, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const insertSession = stmt('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)');
const selectSessionUser = stmt<UserRow & { created: number }>(
  `SELECT u.*, s.created_at AS created FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
);
const deleteSession = stmt('DELETE FROM sessions WHERE token_hash = ?');

/** Creates a session and returns the raw token (only its hash is stored). */
export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  insertSession.run(sha256(token), userId, Date.now());
  return token;
}

export function userFromToken(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const row = selectSessionUser.get(sha256(token));
  if (!row || Date.now() - row.created > SESSION_MAX_AGE_MS) return null;
  return { id: row.id, name: row.name, role: row.role, roomCode: row.room_code };
}

export function destroySession(token: string | undefined) {
  if (token) deleteSession.run(sha256(token));
}

export function getCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Fixed-window limiter for login attempts and other abuse-prone actions. */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Records a hit; returns false when the key is over its limit. */
  hit(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.reset < now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      if (this.hits.size > 10000) this.prune(now);
      return true;
    }
    entry.count++;
    return entry.count <= this.max;
  }

  isBlocked(key: string): boolean {
    const entry = this.hits.get(key);
    return !!entry && entry.reset >= Date.now() && entry.count >= this.max;
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
  }
}
