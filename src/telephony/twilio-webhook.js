/**
 * Twilio Webhook Handler
 * 
 * When a call comes in, Twilio POSTs to this webhook.
 * We look up which agent is assigned to the called phone number,
 * then return TwiML instructing Twilio to connect a Media Stream.
 */

import * as db from '../storage/database.js';
import logger from '../utils/logger.js';
import config from '../config.js';

/**
 * Register the Twilio incoming call webhook route.
 * @param {import('fastify').FastifyInstance} app 
 */
export function registerTwilioWebhook(app) {
  app.post('/webhook/incoming', async (request, reply) => {
    const { To, From, CallSid } = request.body || {};

    logger.info({ to: To, from: From, callSid: CallSid }, '📞 Incoming call');

    // Look up which agent is assigned to this phone number
    const agent = await db.getAgentByPhone(To);

    if (!agent) {
      logger.warn({ to: To }, 'No agent found for this phone number');
      reply.type('text/xml').send(`
        <Response>
          <Say>Sorry, this number is not currently active. Please try again later.</Say>
          <Hangup/>
        </Response>
      `);
      return;
    }

    if (agent.status !== 'active') {
      logger.warn({ agentId: agent.id, status: agent.status }, 'Agent is not active');
      reply.type('text/xml').send(`
        <Response>
          <Say>This agent is currently offline. Please try again later.</Say>
          <Hangup/>
        </Response>
      `);
      return;
    }

    logger.info({ agentId: agent.id, agentName: agent.name }, 'Routing call to agent');

    // Return TwiML that connects a bidirectional Media Stream to our WebSocket server
    const wsUrl = `${config.publicUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/media-stream`;

    reply.type('text/xml').send(`
      <Response>
        <Connect>
          <Stream url="${wsUrl}" bidirectional="true">
            <Parameter name="agentId" value="${agent.id}" />
            <Parameter name="callerNumber" value="${From}" />
          </Stream>
        </Connect>
      </Response>
    `);
  });
}
