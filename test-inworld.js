// Test: Can Inworld actually GENERATE a response? (not just connect)
import 'dotenv/config';
import WebSocket from 'ws';
import crypto from 'crypto';

const BASIC_AUTH = process.env.INWORLD_BASIC_AUTH;
const sessionId = crypto.randomUUID();
const url = `wss://api.inworld.ai/api/v1/realtime/session?key=${sessionId}&protocol=realtime`;

console.log('=== Inworld Content Generation Test ===');
const ws = new WebSocket(url, { headers: { 'Authorization': `Basic ${BASIC_AUTH}` } });

ws.on('open', () => console.log('✅ Connected'));

ws.on('message', (data) => {
  const event = JSON.parse(data.toString());
  console.log(`📨 ${event.type}`, event.error ? JSON.stringify(event.error) : '');
  
  if (event.type === 'session.created') {
    // Configure session
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: 'You are a helpful assistant named Saika.',
        voice: 'shimmer',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: { type: 'server_vad' },
      }
    }));
  }
  
  if (event.type === 'session.updated') {
    console.log('✅ Session configured — sending user message + response.create');
    
    // Send a user message first
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello, who are you?' }],
      },
    }));
    
    // Trigger response
    ws.send(JSON.stringify({
      type: 'response.create',
      response: { modalities: ['audio', 'text'] },
    }));
  }
  
  if (event.type === 'response.audio_transcript.delta') {
    process.stdout.write(event.delta);
  }
  
  if (event.type === 'response.audio.delta') {
    console.log(`🔊 Got audio chunk: ${event.delta.length} chars`);
  }
  
  if (event.type === 'response.done') {
    console.log('\n✅ Response complete! Inworld works end-to-end!');
    ws.close();
    process.exit(0);
  }
  
  if (event.type === 'error') {
    console.error('❌ ERROR:', JSON.stringify(event.error, null, 2));
  }
});

ws.on('error', (err) => { console.error('❌ WS Error:', err.message); process.exit(1); });
ws.on('close', (code) => { console.log('Closed:', code); });

setTimeout(() => { console.error('❌ Timeout'); ws.close(); process.exit(1); }, 15000);
