/**
 * Dynamic System Prompt Builder
 * 
 * Constructs the system prompt + Gemini-format tool declarations
 * dynamically from the agent's config. This is the key to making the
 * platform general-purpose — nothing is hardcoded.
 */

/**
 * Build the full system prompt text for an agent.
 * @param {object} agent - Agent config from database
 * @param {object[]} agentTools - Array of tool definitions for this agent
 * @param {object} [callerContext] - Optional context about the caller
 * @returns {string}
 */
export function buildSystemPrompt(agent, agentTools = [], callerContext = null) {
  const sections = [];

  // ─── Identity ──────────────────────────────────────────
  sections.push(
    `You are ${agent.name}, an AI voice assistant working at ${agent.companyName || 'the company'}.`,
    `Your role: ${agent.role || 'AI Assistant'}.`,
    `Your personality: ${agent.personality || 'Professional, helpful, and concise.'}`
  );

  // ─── Language ──────────────────────────────────────────
  if (agent.language) {
    const langMap = {
      'en': 'English',
      'hi': 'Hindi',
      'en+hi': 'English and Hindi (match whatever the caller speaks; code-switching is fine)',
      'es': 'Spanish',
      'fr': 'French',
      'ar': 'Arabic',
    };
    const langLabel = langMap[agent.language] || agent.language;
    sections.push(`\nLanguage: Respond in ${langLabel}.`);
  }

  // ─── Greeting ──────────────────────────────────────────
  if (agent.greeting) {
    sections.push(`\nWhen the call starts, greet the caller with: "${agent.greeting}"`);
  }

  // ─── Voice behavior ───────────────────────────────────
  const style = agent.conversationStyle || 'natural';
  const styleRules = {
    natural: [
      `- You are on a live phone call. Speak like a real human — use contractions, fillers like "hmm", "well", "actually", "you know".`,
      `- Vary your sentence length. Mix short punchy responses with slightly longer explanations.`,
      `- Show empathy and warmth. React to what the caller says — "Oh that's great!", "I totally understand."`,
      `- Pause naturally. Don't rush through information.`,
      `- Backchannel like a real listener: short acknowledgements ("mm-hmm", "right", "got it") when the caller explains something long — then respond.`,
      `- Mirror the caller's emotional state: if they sound frustrated, slow down, soften your tone, and acknowledge it before problem-solving; if they're excited, match their energy.`,
      `- Never sound like you're reading. If you list options, mention two or three conversationally, not as a numbered list.`,
    ],
    professional: [
      `- You are on a professional phone call. Maintain a polished, corporate tone.`,
      `- Be articulate and clear. Avoid slang or overly casual language.`,
      `- Structure your responses logically. Lead with the answer, then explain.`,
      `- Use proper titles and honorifics when appropriate.`,
    ],
    casual: [
      `- You are on a friendly, casual phone call. Talk like you're chatting with a friend.`,
      `- Use lots of contractions, informal language, and colloquial expressions.`,
      `- Be enthusiastic and energetic. Use words like "awesome", "totally", "yeah for sure".`,
      `- Keep it light and fun. Laugh or react expressively.`,
    ],
    concise: [
      `- You are on a phone call where brevity is valued. Get straight to the point.`,
      `- Answer in 1-2 sentences max. No filler words or preamble.`,
      `- Only elaborate if the caller specifically asks for more detail.`,
      `- Be efficient and respect the caller's time.`,
    ],
  };

  sections.push(
    `\nIMPORTANT VOICE BEHAVIOR RULES:`,
    ...(styleRules[style] || styleRules.natural),
    `- Do NOT use markdown, bullets, or formatting — you are speaking, not writing.`,
    `- If the caller interrupts you, stop talking and listen.`,
    `- Do NOT spell out URLs or email addresses character by character — say them naturally.`,
    `- Keep responses under 3 sentences unless the caller asks for detail.`
  );

  // ─── Knowledge Base ────────────────────────────────────
  sections.push(
    `\nKNOWLEDGE BASE:`,
    `You have access to a knowledge base about ${agent.companyName || 'the company'}.`,
    `When asked questions about the company, its services, products, pricing, or policies, ` +
    `use the "query_knowledge_base" function to find accurate information.`,
    `NEVER make up factual information. If you can't find the answer, say so honestly.`
  );

  // ─── Persona example dialogue ──────────────────────────
  if (agent.exampleDialogue) {
    sections.push(
      `\nHOW YOU SOUND — example conversation. Match this style, rhythm and vocabulary exactly (the content is just an example):`,
      agent.exampleDialogue
    );
  }

  // ─── Custom System Prompt ──────────────────────────────
  if (agent.systemPrompt) {
    sections.push(
      `\nADDITIONAL INSTRUCTIONS:`,
      agent.systemPrompt
    );
  }

  // ─── Guardrails ────────────────────────────────────────
  if (agent.guardrails && agent.guardrails.length > 0) {
    sections.push(`\nSTRICT RULES YOU MUST FOLLOW:`);
    for (const rule of agent.guardrails) {
      sections.push(`- ${rule}`);
    }
  }

  // ─── Transfer ──────────────────────────────────────────
  if (agent.transferNumber) {
    sections.push(
      `\nCALL TRANSFER:`,
      `If you genuinely cannot help the caller, or they explicitly ask to speak to a human, ` +
      `use the "transfer_call" function to connect them to a human agent.`,
      `Before transferring, briefly explain why and wish them well.`
    );
  }

  // ─── Tools ─────────────────────────────────────────────
  const externalTools = agentTools.filter(t => !t.isBuiltIn);
  if (externalTools.length > 0) {
    sections.push(`\nCUSTOM TOOLS AVAILABLE:`);
    for (const tool of externalTools) {
      sections.push(`- ${tool.name}: ${tool.description}`);
    }
    sections.push(
      `Use these tools when the conversation context requires it.`,
      `Always explain what you're doing: "Let me look that up for you..."`
    );
  }

  // ─── Call Summary ──────────────────────────────────────
  sections.push(
    `\nCALL WRAP-UP:`,
    `When the conversation is ending (caller says goodbye, asks to hang up, etc.):`,
    `1. Summarize the key points discussed.`,
    `2. Confirm any next steps or follow-ups.`,
    `3. Use the "log_call_summary" function to save a brief summary.`,
    `4. Say goodbye warmly.`
  );

  // ─── Caller Context (if identified) ────────────────────
  if (callerContext) {
    sections.push(
      `\nCALLER CONTEXT:`,
      `The person calling is: ${callerContext.name || 'Unknown'}`,
    );
    if (callerContext.company) sections.push(`Their company: ${callerContext.company}`);
    if (callerContext.lastInteraction) sections.push(`Last interaction: ${callerContext.lastInteraction}`);
    if (callerContext.notes) sections.push(`Notes: ${callerContext.notes}`);
  }

  return sections.join('\n');
}

/**
 * Build the Gemini-format tool definitions for an agent.
 * Gemini uses: { functionDeclarations: [...] } wrapped in an array.
 * 
 * @param {object} agent - Agent config
 * @param {object[]} userTools - User-defined tools from DB
 * @returns {object[]} - Gemini tools array: [{ functionDeclarations: [...] }]
 */
export function buildToolDefinitions(agent, userTools = []) {
  const functionDeclarations = [];

  // ─── Built-in: query_knowledge_base ────────────────────
  functionDeclarations.push({
    name: 'query_knowledge_base',
    description: `Search the ${agent.companyName || 'company'} knowledge base for information about services, products, pricing, policies, FAQ, etc.`,
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'The question or topic to search for in the knowledge base'
        }
      },
      required: ['query']
    }
  });

  // ─── Built-in: log_call_summary ────────────────────────
  functionDeclarations.push({
    name: 'log_call_summary',
    description: 'Save a brief summary of this call. Use this at the end of every call.',
    parameters: {
      type: 'OBJECT',
      properties: {
        summary: {
          type: 'STRING',
          description: 'A concise 2-3 sentence summary of what was discussed and any action items'
        },
        callerIntent: {
          type: 'STRING',
          description: 'The primary reason the caller called (e.g., "pricing inquiry", "support request")'
        },
        followUpNeeded: {
          type: 'BOOLEAN',
          description: 'Whether a human follow-up is needed'
        }
      },
      required: ['summary']
    }
  });

  // ─── Built-in: transfer_call (if configured) ──────────
  if (agent.transferNumber) {
    functionDeclarations.push({
      name: 'transfer_call',
      description: 'Transfer this call to a human agent. Use when you genuinely cannot help or the caller requests a human.',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: {
            type: 'STRING',
            description: 'Brief reason for the transfer'
          }
        },
        required: ['reason']
      }
    });
  }

  // ─── Built-in: end_call ────────────────────────────────
  functionDeclarations.push({
    name: 'end_call',
    description: 'Gracefully end the call. Use after saying goodbye.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: {
          type: 'STRING',
          description: 'Reason for ending (e.g., "caller said goodbye", "conversation completed")'
        }
      },
      required: ['reason']
    }
  });

  // ─── User-defined tools ────────────────────────────────
  for (const tool of userTools) {
    if (tool.isBuiltIn) continue;

    // Convert user-defined JSON Schema → Gemini OBJECT format
    const params = convertToGeminiParams(tool.parameters);

    functionDeclarations.push({
      name: tool.name,
      description: tool.description,
      parameters: params,
    });
  }

  return [{ functionDeclarations }];
}

/**
 * Convert standard JSON Schema parameters to Gemini's format.
 * Gemini uses uppercase types: STRING, NUMBER, BOOLEAN, OBJECT, ARRAY
 */
function convertToGeminiParams(jsonSchema) {
  if (!jsonSchema) return { type: 'OBJECT', properties: {} };

  const typeMap = {
    'string': 'STRING',
    'number': 'NUMBER',
    'integer': 'INTEGER',
    'boolean': 'BOOLEAN',
    'object': 'OBJECT',
    'array': 'ARRAY',
  };

  const result = {
    type: typeMap[jsonSchema.type?.toLowerCase()] || 'OBJECT',
  };

  if (jsonSchema.properties) {
    result.properties = {};
    for (const [key, val] of Object.entries(jsonSchema.properties)) {
      result.properties[key] = {
        type: typeMap[val.type?.toLowerCase()] || 'STRING',
        description: val.description || '',
      };
    }
  }

  if (jsonSchema.required) {
    result.required = jsonSchema.required;
  }

  return result;
}
