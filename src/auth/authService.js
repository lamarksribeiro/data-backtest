import crypto from 'node:crypto';
import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 12;
const COOKIE_NAME = 'session';

/**
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {object} deps.config
 */
export function createAuthService(deps) {
  const { db, config } = deps;

  function signSession(userId, exp) {
    const payload = `${userId}.${exp}`;
    const hmac = crypto.createHmac('sha256', config.SESSION_SECRET).update(payload).digest('hex');
    return `${payload}.${hmac}`;
  }

  function verifySession(cookieValue) {
    if (!cookieValue) return null;
    const parts = cookieValue.split('.');
    if (parts.length !== 3) return null;
    const [userId, expStr, hmac] = parts;
    const exp = Number.parseInt(expStr, 10);
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return null;
    const expected = crypto.createHmac('sha256', config.SESSION_SECRET).update(`${userId}.${exp}`).digest('hex');
    if (hmac !== expected) return null;
    return { userId, exp };
  }

  async function login(username, password) {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return null;
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return null;
    const exp = Math.floor(Date.now() / 1000) + config.SESSION_MAX_AGE_SEC;
    return { cookie: signSession(user.id, exp), userId: user.id, username: user.username };
  }

  async function validateSession(cookieValue) {
    const parsed = verifySession(cookieValue);
    if (!parsed) return null;
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(parsed.userId);
    if (!user) return null;
    return { kind: 'session', userId: user.id, username: user.username };
  }

  function cookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'Strict',
      secure: config.NODE_ENV === 'production',
      maxAge: config.SESSION_MAX_AGE_SEC,
      path: '/',
    };
  }

  function formatSetCookie(name, value, options) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
    if (options.path) parts.push(`Path=${options.path}`);
    if (options.httpOnly) parts.push('HttpOnly');
    if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
    if (options.secure) parts.push('Secure');
    return parts.join('; ');
  }

  function formatClearCookie(name) {
    return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`;
  }

  async function bootstrapAdmin() {
    const row = db.prepare('SELECT COUNT(*) AS c FROM users').get();
    if (row.c > 0) return null;
    if (!config.INITIAL_ADMIN_USERNAME || !config.INITIAL_ADMIN_PASSWORD) {
      throw new Error('INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD required when no users exist');
    }
    const hash = await bcrypt.hash(config.INITIAL_ADMIN_PASSWORD, BCRYPT_ROUNDS);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
      config.INITIAL_ADMIN_USERNAME,
      hash,
    );
    return config.INITIAL_ADMIN_USERNAME;
  }

  return {
    login,
    validateSession,
    cookieName: COOKIE_NAME,
    cookieOptions,
    formatSetCookie,
    formatClearCookie,
    bootstrapAdmin,
  };
}
