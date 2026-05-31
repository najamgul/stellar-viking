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
  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-004',

  // Inworld AI
  inworldApiKey: process.env.INWORLD_API_KEY,
  inworldApiSecret: process.env.INWORLD_API_SECRET,
  inworldBasicAuth: process.env.INWORLD_BASIC_AUTH,
  inworldTtsApiKey: process.env.INWORLD_TTS_API_KEY,  // TTS/STT/LLM Router API key

  // Sarvam AI
  sarvamApiKey: process.env.SARVAM_API_KEY,

  // Twilio
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,

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

// Validate required keys (gemini only needed for non-pipeline modes)
if (config.aiProvider !== 'pipeline' && !config.geminiApiKey) {
  console.warn('⚠️  Missing required config: geminiApiKey — some features will be unavailable');
}
if (config.aiProvider === 'pipeline' && !config.sarvamApiKey) {
  console.warn('⚠️  Missing required config: sarvamApiKey — pipeline STT/TTS unavailable');
}

// Log auth status
if (config.adminUser) {
  console.log('🔐 Admin authentication ENABLED');
} else {
  console.log('🔓 Admin authentication DISABLED (set ADMIN_USER + ADMIN_PASS to enable)');
}

export default config;
