/**
 * Admin Event Bus — broadcasts real-time events to admin dashboard WebSockets.
 * 
 * Events: call.started, call.ended, call.transcript, call.tool
 */

import logger from '../utils/logger.js';

// Set of connected admin WebSockets
const adminClients = new Set();

/**
 * Register a WebSocket for an admin dashboard.
 * @param {WebSocket} ws
 */
export function registerAdminClient(ws) {
  adminClients.add(ws);
  logger.debug({ clients: adminClients.size }, 'Admin client connected');

  ws.on('close', () => {
    adminClients.delete(ws);
    logger.debug({ clients: adminClients.size }, 'Admin client disconnected');
  });

  // Send initial state
  ws.send(JSON.stringify({ type: 'connected', clients: adminClients.size }));
}

/**
 * Broadcast an event to all connected admin clients.
 * @param {string} type - Event type
 * @param {object} data - Event payload
 */
export function broadcast(type, data) {
  const message = JSON.stringify({ type, data, timestamp: Date.now() });

  for (const ws of adminClients) {
    try {
      if (ws.readyState === 1) { // OPEN
        ws.send(message);
      }
    } catch {
      adminClients.delete(ws);
    }
  }
}

/**
 * Get current admin client count.
 */
export function getAdminClientCount() {
  return adminClients.size;
}
