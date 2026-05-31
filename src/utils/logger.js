import pino from 'pino';
import config from '../config.js';

const logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  transport: config.nodeEnv !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
});

export default logger;

/**
 * Create a child logger scoped to a specific call session.
 * @param {string} callId 
 * @param {string} agentId 
 */
export function createCallLogger(callId, agentId) {
  return logger.child({ callId, agentId });
}
