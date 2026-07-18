/**
 * Chat prompt builder — WhatsApp/text channel.
 *
 * The voice prompt-builder hardcodes "you are on a live phone call";
 * this is its texting counterpart: same agent config, chat register.
 */

const LANG_MAP = {
  'en': 'English',
  'hi': 'Hindi',
  'en+hi': 'English and Hindi (match whatever the lead writes; code-switching is fine)',
  'es': 'Spanish',
  'fr': 'French',
  'ar': 'Arabic',
  'ur': 'Urdu',
};

/**
 * @param {object} agent - Agent config from database
 * @param {object} lead - Lead record (name, status, sentiment, notes)
 * @param {object[]} agentTools - Custom tools for this agent
 */
export function buildChatSystemPrompt(agent, lead, agentTools = []) {
  const now = new Date();
  const sections = [];

  sections.push(
    `You are ${agent.name}, chatting on WhatsApp on behalf of ${agent.companyName || 'the company'}.`,
    `Your role: ${agent.role || 'assistant'}. Your goal is to help this lead, answer their questions, and guide them toward the next step (booking, purchase, or a call with the team).`,
    `Your personality: ${agent.personality || 'Warm, helpful, and concise.'}`,
    ``,
    `Current date and time: ${now.toISOString()} (${now.toUTCString()}).`
  );

  if (agent.language) {
    sections.push(`Language: write in ${LANG_MAP[agent.language] || agent.language}.`);
  }

  sections.push(
    ``,
    `HOW TO TEXT (this is WhatsApp, not email):`,
    `- Write like a real person texting: short messages, contractions, casual warmth. 1-3 short sentences per message.`,
    `- Never use markdown, headers, or bullet lists. Plain text only. Emojis sparingly (max one per message, only when natural).`,
    `- Ask at most ONE question per message.`,
    `- Mirror the lead's tone and language. If they write short, you write short.`,
    `- To send multiple message bubbles, separate them with a blank line. Use 1-2 bubbles normally, 3 max.`,
    `- Never sound like a call-center script. No "How may I assist you today?"`,
    ``,
    `HONESTY:`,
    `- On your very first reply in a conversation, introduce yourself naturally as ${agent.companyName ? `${agent.companyName}'s` : 'the'} assistant.`,
    `- If the lead asks whether you are a bot or AI, answer honestly and positively — never claim to be human.`,
    ``,
    `KNOWLEDGE:`,
    `- Use query_knowledge_base for any factual question about ${agent.companyName || 'the company'} (services, pricing, policies, details).`,
    `- NEVER invent facts, prices, or availability. If the knowledge base doesn't have it, say you'll check with the team and use handoff_to_human if it matters.`,
    ``,
    `LEAD MANAGEMENT (use your tools — this is how the sales team sees your work):`,
    `- Keep the lead's status current with update_lead_status as the conversation evolves:`,
    `  engaged (talking), qualified (real interest + fits what we offer), not_interested (clearly out), closed (done/converted).`,
    `  Always include your read of their sentiment (positive/neutral/negative).`,
    `- If the lead asks you to get back to them later ("message me next week", "after 7pm"), use schedule_followup with the exact ISO datetime and a short context note, then confirm casually.`,
    `- If the lead wants to talk to someone, wants a call, or shares a phone-call preference, use request_callback — a team member will be alerted immediately.`,
    `- If you're stuck, the lead is upset, or they ask for a human, use handoff_to_human. Don't struggle through.`
  );

  if (agent.systemPrompt) {
    sections.push(``, `ADDITIONAL INSTRUCTIONS:`, agent.systemPrompt);
  }

  if (agent.guardrails && agent.guardrails.length > 0) {
    sections.push(``, `STRICT RULES YOU MUST FOLLOW:`);
    for (const rule of agent.guardrails) sections.push(`- ${rule}`);
  }

  const externalTools = agentTools.filter(t => !t.isBuiltIn);
  if (externalTools.length > 0) {
    sections.push(``, `CUSTOM TOOLS AVAILABLE:`);
    for (const tool of externalTools) {
      sections.push(`- ${tool.name}: ${tool.description}`);
    }
  }

  const leadLines = [``, `ABOUT THIS LEAD:`];
  leadLines.push(`- Name: ${lead.name || 'unknown — ask naturally if it comes up, do not interrogate'}`);
  leadLines.push(`- Status: ${lead.status}${lead.sentiment ? `, sentiment: ${lead.sentiment}` : ''}`);
  leadLines.push(`- Source: ${lead.source}`);
  if (lead.metadata && Object.keys(lead.metadata).length > 0) {
    leadLines.push(`- Details from their inquiry: ${JSON.stringify(lead.metadata)}`);
  }
  if (lead.notes && lead.notes.length > 0) {
    leadLines.push(`- Notes: ${lead.notes.slice(-5).map(n => n.text).join(' | ')}`);
  }
  sections.push(...leadLines);

  return sections.join('\n');
}

/**
 * Gemini-format tool declarations for the chat channel.
 * Returns [{ functionDeclarations: [...] }].
 */
export function buildChatToolDeclarations(agent, userTools = []) {
  const functionDeclarations = [
    {
      name: 'query_knowledge_base',
      description: `Search the ${agent.companyName || 'company'} knowledge base for services, products, pricing, policies, FAQ.`,
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'The question or topic to search for' },
        },
        required: ['query'],
      },
    },
    {
      name: 'update_lead_status',
      description: 'Update this lead\'s pipeline status and sentiment. Call whenever your read of the lead changes.',
      parameters: {
        type: 'OBJECT',
        properties: {
          status: {
            type: 'STRING',
            description: 'One of: engaged, qualified, not_interested, closed',
          },
          sentiment: {
            type: 'STRING',
            description: 'One of: positive, neutral, negative',
          },
          note: { type: 'STRING', description: 'Optional one-line note for the sales team' },
        },
        required: ['status', 'sentiment'],
      },
    },
    {
      name: 'schedule_followup',
      description: 'Schedule an automatic follow-up message at a specific future time the lead asked for.',
      parameters: {
        type: 'OBJECT',
        properties: {
          datetime: {
            type: 'STRING',
            description: 'ISO 8601 datetime for the follow-up, e.g. 2026-07-24T18:00:00Z. Must be in the future.',
          },
          context: {
            type: 'STRING',
            description: 'What the follow-up should be about, so the future message makes sense',
          },
        },
        required: ['datetime', 'context'],
      },
    },
    {
      name: 'request_callback',
      description: 'The lead wants a phone call from a human. Alerts the sales team immediately.',
      parameters: {
        type: 'OBJECT',
        properties: {
          preferred_time: { type: 'STRING', description: 'When the lead wants to be called (their words or ISO datetime)' },
          reason: { type: 'STRING', description: 'What the call is about' },
        },
        required: ['reason'],
      },
    },
    {
      name: 'handoff_to_human',
      description: 'Hand this conversation to a human team member and stop replying automatically. Use when stuck, when the lead is upset, or when they ask for a person.',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: { type: 'STRING', description: 'Why you are handing off' },
        },
        required: ['reason'],
      },
    },
  ];

  for (const tool of userTools) {
    if (tool.isBuiltIn) continue;
    functionDeclarations.push({
      name: tool.name,
      description: tool.description,
      parameters: convertParams(tool.parameters),
    });
  }

  return [{ functionDeclarations }];
}

function convertParams(jsonSchema) {
  if (!jsonSchema) return { type: 'OBJECT', properties: {} };
  const typeMap = {
    string: 'STRING', number: 'NUMBER', integer: 'INTEGER',
    boolean: 'BOOLEAN', object: 'OBJECT', array: 'ARRAY',
  };
  const result = { type: typeMap[jsonSchema.type?.toLowerCase()] || 'OBJECT' };
  if (jsonSchema.properties) {
    result.properties = {};
    for (const [key, val] of Object.entries(jsonSchema.properties)) {
      result.properties[key] = {
        type: typeMap[val.type?.toLowerCase()] || 'STRING',
        description: val.description || '',
      };
    }
  }
  if (jsonSchema.required) result.required = jsonSchema.required;
  return result;
}
