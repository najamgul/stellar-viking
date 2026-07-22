import 'dotenv/config';

const config = {
  // Server
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3001',

  // AI Provider ('gemini', 'inworld', or 'pipeline')
  aiProvider: (process.env.AI_PROVIDER || 'gemini').toLowerCase(),

  // Google Gemini
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash-live-001',
  geminiLiveModel: process.env.GEMINI_LIVE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-live-preview',
  embeddingModel: process.env.EMBEDDING_MODEL || 'gemini-embedding-001',

  // Inworld AI
  inworldApiKey: process.env.INWORLD_API_KEY,
  inworldApiSecret: process.env.INWORLD_API_SECRET,
  inworldBasicAuth: process.env.INWORLD_BASIC_AUTH,
  inworldTtsApiKey: process.env.INWORLD_TTS_API_KEY,  // TTS/STT/LLM Router API key

  // Twilio
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,

  // WhatsApp (Meta Cloud API)
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN,        // permanent system-user token
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,        // your own string, echoed in webhook setup
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET,            // Meta app secret, for signature validation
  whatsappApiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
  whatsappFollowupTemplate: process.env.WHATSAPP_FOLLOWUP_TEMPLATE || null,  // approved template name for >24h re-engagement
  whatsappTemplateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
  chatModel: process.env.CHAT_MODEL || 'gemini-flash-latest',

  // Chat LLM provider — 'gemini' (default, also handles voice-note
  // transcription) or 'replicate' (DeepSeek et al. via Replicate; text only,
  // tools via in-prompt protocol). Set per-agent via agent.chatProvider.
  chat: {
    provider: (process.env.CHAT_PROVIDER || 'gemini').toLowerCase(),
  },
  replicate: {
    apiToken: process.env.REPLICATE_API_TOKEN || null,
    model: process.env.REPLICATE_MODEL || 'deepseek-ai/deepseek-v3.1',
    maxTokens: parseInt(process.env.REPLICATE_MAX_TOKENS || '1500', 10),
    temperature: parseFloat(process.env.REPLICATE_TEMPERATURE || '0.7'),
  },

  // CRM sync connector (global default — agents can override with
  // agent.crmSyncUrl / agent.crmSyncKey; unset = feature off)
  crmSync: {
    url: process.env.CRM_SYNC_URL || null,   // e.g. https://your-crm.app/api/ingest/chatbot
    key: process.env.CRM_SYNC_KEY || null,   // sent as x-crm-key header
  },

  // Automated outreach window (lead-local hours). Applies to nudges,
  // window-savers, re-engagement drips and scheduled follow-ups — NOT to
  // direct replies (we always answer an incoming message immediately).
  outreach: {
    startHour: parseInt(process.env.OUTREACH_START_HOUR || '10', 10),
    endHour: parseInt(process.env.OUTREACH_END_HOUR || '19', 10),
  },

  // Paid re-engagement drip after the free 24h window closes.
  // Hours since the lead's last message for each PAID template attempt;
  // list length = per-lead spend cap. Requires WHATSAPP_FOLLOWUP_TEMPLATE.
  reengage: {
    enabled: process.env.REENGAGE_ENABLED !== 'false',
    delaysHours: (process.env.REENGAGE_DELAYS_HOURS || '26,72,168')
      .split(',').map(Number).filter(n => Number.isFinite(n) && n > 24),
  },

  // Pinecone
  pineconeApiKey: process.env.PINECONE_API_KEY,
  pineconeIndexName: process.env.PINECONE_INDEX_NAME || 'stellar-viking',

  // Google Cloud
  gcsBucketName: process.env.GCS_BUCKET_NAME || 'stellar-viking-recordings',

  // Security
  encryptionKey: process.env.ENCRYPTION_KEY,

  // Admin Authentication (set these to enable auth)
  adminUser: process.env.ADMIN_USER || null,
  adminPass: process.env.ADMIN_PASS || null,
  adminSecret: process.env.ADMIN_SECRET || process.env.ENCRYPTION_KEY || 'stellar-viking-dev-secret',

  // Defaults
  defaults: {
    voice: 'Kore',
    language: 'en',
    toolTimeout: 5000,
    kbTopK: 3,
    maxCallDuration: 30 * 60, // 30 minutes
  }
};

// Validate required keys
// (chat + embeddings + summaries always need Gemini; pipeline voice mode uses Inworld)
if (!config.geminiApiKey) {
  console.warn('⚠️  Missing required config: geminiApiKey — chat engine, knowledge base, and Gemini voice will be unavailable');
}
if (config.aiProvider === 'pipeline' && !config.inworldTtsApiKey) {
  console.warn('⚠️  Missing required config: inworldTtsApiKey — pipeline voice mode unavailable');
}

// Auth: fail closed in production. Running with an open admin API in
// production leaks every lead and conversation to the internet.
if (config.adminUser) {
  console.log('🔐 Admin authentication ENABLED');
} else if (config.nodeEnv === 'production' && process.env.ALLOW_NO_AUTH !== 'true') {
  console.error('❌ ADMIN_USER/ADMIN_PASS not set in production. Refusing to start.');
  console.error('   Set admin credentials, or set ALLOW_NO_AUTH=true to explicitly run open (NOT recommended).');
  process.exit(1);
} else {
  console.log('🔓 Admin authentication DISABLED (set ADMIN_USER + ADMIN_PASS to enable)');
}

export default config;
