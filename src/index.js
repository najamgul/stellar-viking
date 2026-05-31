/**
 * Stellar Viking — Voice AI Agent Platform
 * 
 * Entry point. Sets up the Fastify server with:
 *   - REST API routes (agents, knowledge, tools, calls)
 *   - Twilio webhook endpoint
 *   - WebSocket endpoint for Twilio Media Streams
 *   - Browser test WebSocket endpoint (for testing without Twilio)
 *   - Admin WebSocket for live monitoring
 *   - Authentication & rate limiting
 *   - Health check endpoint
 *   - Static file serving for the admin dashboard
 */

import path from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import config from './config.js';
import logger from './utils/logger.js';
import { registerApiRoutes } from './api/routes.js';
import { registerTwilioWebhook } from './telephony/twilio-webhook.js';
import { registerMediaStream } from './telephony/media-stream.js';
import { registerTestCall } from './api/test-call.js';
import { registerOutboundCall } from './api/outbound-call.js';
import { registerAdminClient } from './api/admin-events.js';
import { registerAuth, registerAuthGuard } from './api/auth.js';
import { registerMiddleware } from './api/middleware.js';
import { registerPdfExport, closePdfBrowser } from './api/pdf-export.js';
import * as db from './storage/database.js';
import { getActiveSessionCount } from './engine/session-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function start() {
  const app = Fastify({
    logger: false,  // We use our own pino logger
    bodyLimit: 5 * 1024 * 1024,  // 5MB body limit
  });

  // ─── Plugins ─────────────────────────────────────────────
  await app.register(cors, { origin: true });
  await app.register(formbody);        // Parse Twilio's application/x-www-form-urlencoded
  await app.register(websocket);       // WebSocket support

  // Serve static files (admin dashboard, test console)
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  // ─── Middleware (security headers, rate limiting, request logging) ──
  registerMiddleware(app);

  // ─── Authentication ──────────────────────────────────────
  registerAuthGuard(app);              // Protect admin routes
  registerAuth(app);                   // /api/auth/login, /api/auth/me

  // ─── Health Check ────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    version: '1.0.0',
    activeSessions: getActiveSessionCount(),
    agents: (await db.listAgents()).length,
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    },
    timestamp: new Date().toISOString(),
  }));

  // ─── Routes ──────────────────────────────────────────────
  registerApiRoutes(app);              // /api/*
  registerTwilioWebhook(app);          // /webhook/incoming
  registerMediaStream(app);            // /media-stream (Twilio WebSocket)
  registerTestCall(app);               // /test-call (Browser WebSocket)
  registerOutboundCall(app);           // /api/call-me (outbound)
  registerPdfExport(app);               // /api/export-pdf (Puppeteer PDF)

  // ─── Admin Live Monitor WebSocket ───────────────────────
  app.get('/admin-ws', { websocket: true }, (socket) => {
    registerAdminClient(socket);
  });

  // ─── Analytics API ──────────────────────────────────────
  app.get('/api/analytics', async (request) => {
    const agentId = request.query.agentId || null;
    const agents = await db.listAgents();

    let allCalls = [];
    for (const agent of agents) {
      if (agentId && agent.id !== agentId) continue;
      const calls = await db.listCalls(agent.id, 500);
      allCalls = allCalls.concat(calls.map(c => ({ ...c, agentName: agent.name })));
    }

    // Call volume by day (last 30 days)
    const now = Date.now();
    const dayMs = 86400000;
    const volumeByDay = {};
    for (let i = 29; i >= 0; i--) {
      const date = new Date(now - i * dayMs).toISOString().split('T')[0];
      volumeByDay[date] = 0;
    }
    for (const c of allCalls) {
      const date = new Date(c.startedAt).toISOString().split('T')[0];
      if (volumeByDay[date] !== undefined) volumeByDay[date]++;
    }

    const durations = allCalls.filter(c => c.duration).map(c => parseInt(c.duration) || 0);
    const avgDuration = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const maxDuration = durations.length ? Math.max(...durations) : 0;

    const statusBreakdown = {};
    for (const c of allCalls) {
      statusBreakdown[c.status] = (statusBreakdown[c.status] || 0) + 1;
    }

    const callsByAgent = {};
    for (const c of allCalls) {
      const name = c.agentName || 'Unknown';
      callsByAgent[name] = (callsByAgent[name] || 0) + 1;
    }

    return {
      totalCalls: allCalls.length,
      activeSessions: getActiveSessionCount(),
      avgDuration,
      maxDuration,
      volumeByDay,
      statusBreakdown,
      callsByAgent,
    };
  });

  // ─── Graceful Shutdown ──────────────────────────────────
  const shutdown = async (signal) => {
    logger.info({ signal }, '🛑 Shutting down gracefully...');

    // Give active connections 5 seconds to finish
    setTimeout(() => {
      logger.warn('Force shutdown after timeout');
      process.exit(1);
    }, 5000).unref();

    try {
      await closePdfBrowser();
      await app.close();
      logger.info('✅ Server closed');
      process.exit(0);
    } catch (err) {
      logger.error({ error: err.message }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Catch unhandled errors
  process.on('unhandledRejection', (reason) => {
    logger.error({ error: reason?.message || reason }, '🔥 Unhandled rejection');
  });

  process.on('uncaughtException', (error) => {
    logger.error({ error: error.message, stack: error.stack }, '🔥 Uncaught exception');
    shutdown('uncaughtException');
  });

  // ─── Start ───────────────────────────────────────────────
  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info({}, `
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │   Stellar Viking — Voice AI Agent Platform       │
  │                                                  │
  │   Server:  http://${config.host}:${config.port}              │
  │   Admin:   http://localhost:${config.port}/admin.html │
  │   Health:  http://localhost:${config.port}/health      │
  │   Engine:  ${{'pipeline':'Inworld Realtime S2S','inworld':'Inworld AI Realtime','gemini':'Gemini Live API'}[config.aiProvider] || 'Gemini Live API'}         │
  │   Model:   ${config.aiProvider === 'pipeline' ? 'gemini-2.5-flash + tts-1.5' : config.aiProvider === 'inworld' ? 'inworld-realtime-v1' : config.geminiModel}       │
  │   Storage: File-based (./data)                   │
  │   Auth:    ${config.adminUser ? 'ENABLED' : 'DISABLED (dev mode)'}                    │
  │                                                  │
  └──────────────────────────────────────────────────┘
    `);
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to start server');
    process.exit(1);
  }
}

start();
