/**
 * Chat LLM provider selector.
 *
 * Per-agent override (agent.chatProvider) falls back to the global
 * CHAT_PROVIDER env. Unknown/unset → Gemini. If Replicate is selected but no
 * token is configured, fall back to Gemini so the bot never goes silent.
 */
import config from '../../config.js';
import logger from '../../utils/logger.js';
import { geminiProvider } from './gemini-provider.js';
import { replicateProvider } from './replicate-provider.js';

export function getChatProvider(agent) {
  const choice = (agent?.chatProvider || config.chat.provider || 'gemini').toLowerCase();

  if (choice === 'replicate') {
    if (!config.replicate.apiToken) {
      logger.warn('CHAT_PROVIDER=replicate but REPLICATE_API_TOKEN is missing — using Gemini');
      return geminiProvider;
    }
    return replicateProvider;
  }
  return geminiProvider;
}

/**
 * Emergency fallback: if the primary provider fails (e.g. Gemini billing
 * suspension → 403), the other configured provider takes the turn. A
 * slightly different voice beats a silent bot; recovery is automatic once
 * the primary heals.
 */
export function getFallbackProvider(primary) {
  if (primary.name !== 'replicate' && config.replicate.apiToken) return replicateProvider;
  if (primary.name !== 'gemini' && config.geminiApiKey) return geminiProvider;
  return null;
}
