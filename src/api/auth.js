/**
 * Admin Authentication — simple JWT-based auth.
 * 
 * Credentials set via ADMIN_USER / ADMIN_PASS env vars.
 * Issues a JWT token that the dashboard sends as Authorization header.
 * 
 * If ADMIN_USER is not set, auth is disabled (dev mode).
 */

import crypto from 'crypto';
import config from '../config.js';
import logger from '../utils/logger.js';

// Simple JWT-like token using HMAC
const SECRET = config.adminSecret || config.encryptionKey || 'stellar-viking-dev-key';
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Create a signed token.
 */
function createToken(username) {
  const payload = {
    sub: username,
    iat: Date.now(),
    exp: Date.now() + TOKEN_EXPIRY,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Verify a token. Returns payload or null.
 */
function verifyToken(token) {
  try {
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
    if (sig !== expected) return null;

    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

/** Constant-time string compare (avoids timing side-channel on login). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Login handler — POST /api/auth/login
 */
export function registerAuth(app) {
  // Login endpoint
  app.post('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body || {};

    if (!config.adminUser) {
      // Auth disabled in dev mode
      return { token: createToken('admin'), user: 'admin' };
    }

    if (safeEqual(username, config.adminUser) && safeEqual(password, config.adminPass)) {
      logger.info({ user: username }, '🔐 Admin login successful');
      return { token: createToken(username), user: username };
    }

    logger.warn({ user: username }, '🔐 Admin login failed');
    reply.code(401);
    return { error: 'Invalid credentials' };
  });

  // Check auth status
  app.get('/api/auth/me', async (request, reply) => {
    const user = extractUser(request);
    if (!user) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    return { user: user.sub };
  });
}

/**
 * Auth guard middleware hook — protects /api/* and /admin.html
 * Accepts both JWT Bearer tokens (admin dashboard) and API keys (external systems).
 */
export function registerAuthGuard(app) {
  app.addHook('onRequest', async (request, reply) => {
    // Skip auth if admin credentials not configured (dev mode)
    if (!config.adminUser) return;

    const path = request.url.split('?')[0];

    // Public endpoints — always accessible
    // (/webhook/whatsapp is protected by Meta signature validation,
    //  /webhook/incoming by Twilio; /api/leads/capture is the public
    //  landing-page form endpoint.)
    const publicPaths = [
      '/api/auth/login',
      '/api/leads/capture',
      '/webhook/',
      '/media-stream',
      '/test-call',
      '/admin-ws',
      '/health',
      '/test.html',
      '/favicon.ico',
    ];

    if (publicPaths.some(p => path.startsWith(p))) return;

    // Login page itself is public
    if (path === '/login.html') return;

    // Protect /admin.html — client-side checks token
    if (path === '/admin.html') return;

    // API docs page is public
    if (path === '/docs.html') return;

    // Protect API routes — accept JWT or API key
    if (path.startsWith('/api/')) {
      // Check JWT first (admin dashboard)
      const user = extractUser(request);
      if (user) return;

      // Key management is admin-only: an API key must never be able to
      // mint, list, or revoke keys (privilege escalation).
      if (path.startsWith('/api/keys')) {
        reply.code(401);
        return reply.send({ error: 'Admin authentication required for key management.' });
      }

      // Check API key (external systems: sv_live_xxx)
      const apiKeyValid = await checkApiKey(request);
      if (apiKeyValid) return;

      reply.code(401);
      return reply.send({ error: 'Authentication required. Use Bearer token or API key.' });
    }
  });
}

/**
 * Extract user from Authorization header (JWT).
 */
function extractUser(request) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  // Don't try to verify API keys as JWT
  if (token.startsWith('sv_live_')) return null;
  return verifyToken(token);
}

/**
 * Check API key from header or query param.
 */
async function checkApiKey(request) {
  // Dynamic import to avoid circular dependency
  const { validateApiKey } = await import('./api-keys.js');

  // Check Authorization: Bearer sv_live_xxx
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer sv_live_')) {
    return validateApiKey(auth.slice(7)) !== null;
  }

  // Check X-API-Key header
  const apiKey = request.headers['x-api-key'];
  if (apiKey?.startsWith('sv_live_')) {
    return validateApiKey(apiKey) !== null;
  }

  // Check query param ?api_key=sv_live_xxx
  const queryKey = request.query?.api_key;
  if (queryKey?.startsWith('sv_live_')) {
    return validateApiKey(queryKey) !== null;
  }

  return false;
}

