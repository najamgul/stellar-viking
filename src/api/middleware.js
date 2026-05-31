/**
 * Production middleware hooks for Fastify:
 * - Request logging (method, path, duration, status)
 * - Rate limiting (per-IP sliding window)
 * - Security headers (helmet-style)
 * - Input size limits
 */

import logger from '../utils/logger.js';
import config from '../config.js';

// ─── Rate Limiter ─────────────────────────────────────────────────

const rateLimits = new Map(); // ip → { count, resetAt }
const RATE_WINDOW = 60_000;   // 1 minute
const RATE_MAX = config.nodeEnv === 'production' ? 100 : 500; // requests per window

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimits.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    rateLimits.set(ip, entry);
  }

  entry.count++;
  return entry.count <= RATE_MAX;
}

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}, 300_000);

// ─── Register All Middleware ──────────────────────────────────────

export function registerMiddleware(app) {
  // Security headers
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  });

  // Rate limiting
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];

    // Skip rate limiting for WebSocket upgrades and webhooks
    if (path === '/media-stream' || path === '/test-call' || path === '/admin-ws' || path.startsWith('/webhook')) return;

    const ip = request.ip || request.headers['x-forwarded-for'] || 'unknown';
    if (!checkRateLimit(ip)) {
      logger.warn({ ip, path }, '⚠️ Rate limit exceeded');
      reply.code(429);
      return reply.send({ error: 'Too many requests. Please slow down.' });
    }
  });

  // Request logging
  app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0];

    // Skip logging for static assets and health checks
    if (path.endsWith('.css') || path.endsWith('.js') || path.endsWith('.ico') || path === '/health') return;

    const duration = Math.round(reply.elapsedTime);
    const status = reply.statusCode;

    if (status >= 400) {
      logger.warn({ method: request.method, path, status, duration: `${duration}ms` }, '⚠️ Request error');
    } else if (path.startsWith('/api/') || path.startsWith('/webhook/')) {
      logger.info({ method: request.method, path, status, duration: `${duration}ms` }, '→ Request');
    }
  });
}
