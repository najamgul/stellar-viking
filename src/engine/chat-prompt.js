/**
 * Chat prompt builder — WhatsApp/text channel.
 *
 * The voice prompt-builder hardcodes "you are on a live phone call";
 * this is its texting counterpart: same agent config, chat register.
 */

import { getPhoneLocale, getLocalHour } from './phone-locale.js';

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

  const localHour = getLocalHour(lead.phone, now);
  const locale = getPhoneLocale(lead.phone);
  if (localHour !== null) {
    const daypart = localHour < 5 ? 'late night' : localHour < 12 ? 'morning'
      : localHour < 17 ? 'afternoon' : localHour < 21 ? 'evening' : 'night';
    sections.push(`For the lead it is currently ${daypart} (~${localHour}:00 their local time) — greet and phrase accordingly.`);
  }
  if (locale?.utcOffset !== null && locale?.utcOffset !== undefined) {
    const off = locale.utcOffset;
    const offStr = `${off >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off))).padStart(2, '0')}:${Math.abs(off) % 1 === 0.5 ? '30' : Math.abs(off) % 1 === 0.75 ? '45' : '00'}`;
    sections.push(
      `TIMEZONE: the lead is in ${locale.country}, UTC${offStr}. When they name a time ("4 pm", "kal subah"), they ALWAYS mean THEIR local time. ` +
      `For schedule_followup, write the ISO datetime WITH their offset — e.g. 4 pm for them = 16:00:00${offStr} — never plain "Z"/UTC unless you have converted correctly.`
    );
  }

  if (agent.language) {
    sections.push(`Language: write in ${LANG_MAP[agent.language] || agent.language}.`);
  }

  sections.push(
    ``,
    `HOW TO TEXT (this is WhatsApp, not email):`,
    `- Write like a real person texting: short messages, contractions, casual warmth. 1-3 short sentences per message.`,
    `- Never use markdown, headers, or bullet lists. Plain text only. Emojis sparingly (max one per message, only when natural).`,
    `- Ask at most ONE question per message.`,
    `- Mirror the lead's tone, language AND script. If they write Hindi/Urdu in Latin letters (Hinglish / Roman Urdu, e.g. "kitna price hai?"), reply the same way in Latin letters — never switch to Devanagari or Urdu script unless they do.`,
    `- To send multiple message bubbles, separate them with a blank line. Use 1-2 bubbles normally, 3 max.`,
    `- Never sound like a call-center script. No "How may I assist you today?"`,
    ``,
    `TOOLS ARE INVISIBLE:`,
    `- Use tools ONLY through the function-calling mechanism. NEVER write a tool name, tool syntax, JSON, code, or anything like "update_lead_status{...}" or "default_api" in your message text — the lead sees your text word for word.`,
    `- Never narrate what tools you are using ("let me update your status"). Tool use is silent back-office work.`,
    ``,
    `HONESTY:`,
    `- On your very first reply in a conversation, introduce yourself naturally as ${agent.companyName ? `${agent.companyName}'s` : 'the'} assistant.`,
    `- If the lead asks whether you are a bot or AI, answer honestly and positively — never claim to be human.`,
    ``,
    `KNOWLEDGE:`,
    `- Use query_knowledge_base for any factual question about ${agent.companyName || 'the company'} (services, pricing, policies, details).`,
    `- NEVER invent facts, prices, or availability. If the knowledge base doesn't have it, say you'll check with the team and use handoff_to_human if it matters.`,
    ...buildMoneySection(lead),
    ``,
    `LEAD MANAGEMENT (use your tools — this is how the sales team sees your work):`,
    `- Keep the lead's status current with update_lead_status as the conversation evolves:`,
    `  engaged (talking), qualified (real interest + fits what we offer), not_interested (clearly out), closed (done/converted).`,
    `  Always include your read of their sentiment (positive/neutral/negative).`,
    `- If the lead asks you to get back to them later ("message me next week", "after 7pm"), use schedule_followup with the exact ISO datetime and a short context note, then confirm casually.`,
    `- If the lead wants to talk to someone, wants a call, or shares a phone-call preference, use request_callback — a team member will be alerted immediately.`,
    `- If you're stuck, the lead is upset, or they ask for a human, use handoff_to_human. Don't struggle through.`,
    `- When the lead shares a lasting personal detail (budget, travel dates, group size, preferences, occupation…), save it with remember_lead_fact so future conversations remember it. Don't announce that you're saving anything.`
  );

  if (agent.exampleDialogue) {
    sections.push(
      ``,
      `HOW YOU SOUND — example conversation. Match this style, rhythm and vocabulary exactly (the content is just an example):`,
      agent.exampleDialogue
    );
  }

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
  const facts = lead.metadata?.facts;
  if (facts && Object.keys(facts).length > 0) {
    leadLines.push(`- Known facts (from earlier conversations — use them naturally, don't recite them): ${Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
  }
  if (lead.notes && lead.notes.length > 0) {
    leadLines.push(`- Notes: ${lead.notes.slice(-5).map(n => n.text).join(' | ')}`);
  }
  sections.push(...leadLines);

  return sections.join('\n');
}

/** Currency rules based on the lead's phone country code. */
function buildMoneySection(lead) {
  const locale = getPhoneLocale(lead.phone);
  if (!locale) {
    return [
      ``,
      `MONEY & CURRENCY:`,
      `- Only quote specific prices that come from the knowledge base, in the exact currency the knowledge base states. Never invent prices or exchange rates.`,
    ];
  }
  const lines = [
    ``,
    `MONEY & CURRENCY:`,
    `- The lead is messaging from ${locale.country} (${locale.callingCode}). ALL money talk is in their currency: ${locale.currency} (${locale.symbol}) — e.g. "${locale.symbol}5,000".`,
    `- Specific prices must come from the knowledge base. Quote them in the exact currency the knowledge base states — do NOT convert between currencies or invent exchange rates. If that differs from the lead's currency, just name the currency clearly.`,
    `- If asked for a price the knowledge base doesn't have, NEVER guess a number — say you'll confirm with the team.`,
  ];
  if (locale.currency !== 'USD') {
    lines.push(`- HARD RULE: never write "$" or "USD" to this lead. A dollar price to a ${locale.country} lead is wrong and loses the sale. If a source shows dollars, do not quote it — confirm with the team instead.`);
  }
  return lines;
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
            description: 'ISO 8601 datetime for the follow-up IN THE LEAD\'S LOCAL TIME with their UTC offset (see TIMEZONE in your instructions), e.g. 2026-07-24T16:00:00+05:30 for 4 pm in India. Must be in the future.',
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
      name: 'remember_lead_fact',
      description: 'Save a lasting fact about this lead (budget, dates, group size, preferences…) so future conversations and calls remember it.',
      parameters: {
        type: 'OBJECT',
        properties: {
          key: { type: 'STRING', description: 'Short fact key, e.g. "budget", "travel_dates", "group_size"' },
          value: { type: 'STRING', description: 'The fact, e.g. "around ₹80,000 total"' },
        },
        required: ['key', 'value'],
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
