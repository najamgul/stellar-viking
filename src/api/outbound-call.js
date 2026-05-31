/**
 * Outbound Call API — makes Twilio call YOUR phone,
 * then connects to the AI agent via Media Stream.
 * 
 * POST /api/call-me
 * Body: { "to": "+91XXXXXXXXXX", "agentId": "..." }
 */

import twilio from 'twilio';
import config from '../config.js';
import logger from '../utils/logger.js';

/**
 * Register the outbound call route.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerOutboundCall(app) {

  app.post('/api/call-me', async (request, reply) => {
    const { to, agentId } = request.body || {};

    if (!to) {
      return reply.code(400).send({ error: 'Missing "to" phone number' });
    }

    if (!config.twilioAccountSid || !config.twilioAuthToken) {
      return reply.code(500).send({ error: 'Twilio credentials not configured' });
    }

    const client = twilio(config.twilioAccountSid, config.twilioAuthToken);

    // Build TwiML that connects to our Media Stream WebSocket
    const wsUrl = `${config.publicUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/media-stream`;

    const twiml = `
      <Response>
        <Connect>
          <Stream url="${wsUrl}" bidirectional="true">
            <Parameter name="agentId" value="${agentId || 'default'}" />
            <Parameter name="callerNumber" value="${to}" />
          </Stream>
        </Connect>
      </Response>
    `.trim();

    try {
      const call = await client.calls.create({
        to: to,
        from: '+17754761653',  // Your Twilio number
        twiml: twiml,
      });

      logger.info({ callSid: call.sid, to }, '📞 Outbound call initiated');

      return {
        success: true,
        callSid: call.sid,
        message: `Calling ${to} — pick up your phone!`,
      };
    } catch (err) {
      logger.error({ error: err.message, code: err.code }, 'Failed to initiate outbound call');
      return reply.code(500).send({
        error: err.message,
        hint: err.code === 21219
          ? 'This number is not verified. Go to Twilio Console → Verified Caller IDs and add it.'
          : undefined,
      });
    }
  });
}
