/**
 * Twilio Media Stream WebSocket Handler
 * 
 * Handles the bidirectional audio WebSocket connection from Twilio.
 * When a media stream connects, we create a session that bridges
 * Twilio audio ↔ Gemini Live API.
 */

import * as db from '../storage/database.js';
import { createSession } from '../engine/session-manager.js';
import logger from '../utils/logger.js';

/**
 * Register the WebSocket route for Twilio Media Streams.
 * @param {import('fastify').FastifyInstance} app 
 */
export function registerMediaStream(app) {
  app.register(async function (fastify) {
    fastify.get('/media-stream', { websocket: true }, (socket, req) => {
      logger.info('Twilio Media Stream WebSocket connected');

      let session = null;
      let streamSid = null;

      socket.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());

          switch (data.event) {
            // ─── Stream connected — metadata arrives ─────────
            case 'connected':
              logger.debug('Twilio stream connected event');
              break;

            // ─── Stream started — contains stream SID and custom params ──
            case 'start':
              streamSid = data.start.streamSid;
              const agentId = data.start.customParameters?.agentId;
              const callerNumber = data.start.customParameters?.callerNumber || 'unknown';

              logger.info({ streamSid, agentId, callerNumber }, 'Media stream started');

              if (!agentId) {
                logger.error('No agentId in stream parameters');
                socket.close();
                return;
              }

              // Load agent config
              const agent = await db.getAgent(agentId);
              if (!agent) {
                logger.error({ agentId }, 'Agent not found');
                socket.close();
                return;
              }

              // Create the call session (bridges Twilio ↔ Gemini)
              try {
                session = await createSession({
                  agent,
                  callerNumber,
                  twilioStreamSid: streamSid,
                  twilioCallSid: data.start.callSid,
                  twilioWs: socket,
                });
              } catch (err) {
                logger.error({ error: err.message }, 'Failed to create session');
                socket.close();
              }
              break;

            // ─── Audio data from caller ──────────────────────
            case 'media':
              if (session && data.media?.payload) {
                session.handleTwilioAudio(data.media.payload);
              }
              break;

            // ─── Stream stopped ──────────────────────────────
            case 'stop':
              logger.info({ streamSid }, 'Twilio stream stopped');
              if (session) {
                await session.handleStreamEnd();
              }
              break;

            // ─── DTMF tone detected ──────────────────────────
            case 'dtmf':
              logger.debug({ digit: data.dtmf?.digit }, 'DTMF received');
              break;

            default:
              logger.debug({ event: data.event }, 'Unknown Twilio event');
          }
        } catch (err) {
          logger.error({ error: err.message }, 'Error processing Twilio message');
        }
      });

      socket.on('close', async () => {
        logger.info({ streamSid }, 'Twilio WebSocket closed');
        if (session) {
          await session.handleStreamEnd();
        }
      });

      socket.on('error', (err) => {
        logger.error({ error: err.message }, 'Twilio WebSocket error');
      });
    });
  });
}
