/**
 * Seed a demo agent for testing.
 * Run: node scripts/seed-demo-agent.js
 * 
 * This creates a sample agent via the API so you can test
 * the full flow without the admin console.
 */

const BASE_URL = process.env.API_URL || 'http://localhost:3001';

async function seed() {
  console.log('🌱 Seeding demo agent...\n');

  // 1. Create agent
  const agentRes = await fetch(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Sarah',
      companyName: 'Acme Consulting',
      role: 'Customer Relations Manager',
      personality: 'Warm, professional, and knowledgeable. Uses a consultative approach. Speaks clearly and concisely.',
      voice: 'Kore',
      language: 'en+hi',
      greeting: 'Hi, thanks for calling Acme Consulting! This is Sarah. How can I help you today?',
      guardrails: [
        'Never share internal pricing formulas or margins',
        'Never badmouth competitors',
        'Never commit to discounts without transferring to a manager',
        'Never share personal opinions on politics or religion'
      ],
      transferNumber: '+911234567890',
      consentMessage: 'This call is being recorded for quality and training purposes.',
      phoneNumber: '+1234567890',  // Replace with your actual Twilio number
      status: 'active',
    }),
  });

  const { agent } = await agentRes.json();
  console.log(`✅ Agent created: ${agent.name} (${agent.id})`);
  console.log(`   Company: ${agent.companyName}`);
  console.log(`   Voice: ${agent.voice}`);
  console.log(`   Phone: ${agent.phoneNumber}\n`);

  // 2. Add a sample tool
  const toolRes = await fetch(`${BASE_URL}/api/agents/${agent.id}/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'check_appointment',
      description: 'Check if a client has an upcoming appointment. Use when the caller asks about their appointment.',
      parameters: {
        type: 'object',
        properties: {
          clientName: { type: 'string', description: 'Name of the client' },
          phone: { type: 'string', description: 'Phone number of the client' },
        },
        required: ['clientName']
      },
      endpointUrl: 'https://jsonplaceholder.typicode.com/todos/1', // Mock endpoint
      httpMethod: 'GET',
      authType: 'none',
      timeout: 5000,
    }),
  });

  const { tool } = await toolRes.json();
  console.log(`✅ Tool created: ${tool.name} (${tool.id})`);
  console.log(`   Endpoint: ${tool.endpointUrl}\n`);

  // 3. Add a sample knowledge document (via API — text content)
  const kbRes = await fetch(`${BASE_URL}/api/agents/${agent.id}/knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: 'services.txt',
      fileType: 'txt',
      content: `Acme Consulting Services

We offer the following services:

1. Business Registration & Compliance
   - Company incorporation (Private Limited, LLP, OPC)
   - GST registration and filing
   - Annual compliance and ROC filing
   - MSME/Startup registration

2. Accounting & Taxation
   - Bookkeeping and accounting
   - Income tax return filing
   - TDS compliance
   - Tax planning and advisory

3. Legal Services
   - Contract drafting and review
   - Intellectual property registration (trademark, copyright)
   - Legal notices and dispute resolution

Pricing:
- Company registration starts at INR 7,999
- GST registration starts at INR 2,499
- Annual compliance packages start at INR 14,999/year
- Custom packages available for larger businesses

Contact: info@acmeconsulting.com | +91-1234567890
Office hours: Monday to Saturday, 10 AM to 7 PM IST`
    }),
  });

  const { document } = await kbRes.json();
  console.log(`✅ Knowledge doc created: ${document.fileName} (${document.id})\n`);

  console.log('─────────────────────────────────────────');
  console.log('🎉 Demo agent ready!');
  console.log(`   Agent ID: ${agent.id}`);
  console.log(`   Assign Twilio number: ${agent.phoneNumber}`);
  console.log(`   Configure Twilio webhook: POST ${process.env.PUBLIC_URL || 'https://your-ngrok-url'}/webhook/incoming`);
  console.log('─────────────────────────────────────────');
}

seed().catch(console.error);
