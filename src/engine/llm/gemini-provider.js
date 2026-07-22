/**
 * Gemini chat provider — native function-calling tool loop.
 *
 * This is the default provider and a faithful port of the loop that used to
 * live inline in chat-session.runAiTurn, so behavior is unchanged when
 * CHAT_PROVIDER is unset. Voice-note transcription stays in chat-session
 * (also Gemini) — this module only handles the text tool loop.
 */
import { GoogleGenAI } from '@google/genai';
import config from '../../config.js';

let _client = null;
function getClient() {
  if (!_client) _client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return _client;
}

const TYPE_MAP = {
  string: 'STRING', number: 'NUMBER', integer: 'INTEGER',
  boolean: 'BOOLEAN', object: 'OBJECT', array: 'ARRAY',
};

/** Neutral tool spec → Gemini [{ functionDeclarations: [...] }]. */
function toGeminiTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  const functionDeclarations = tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: 'OBJECT',
      properties: Object.fromEntries(
        Object.entries(t.parameters || {}).map(([k, v]) => [
          k,
          { type: TYPE_MAP[(v.type || 'string').toLowerCase()] || 'STRING', description: v.description || '' },
        ])
      ),
      required: t.required || [],
    },
  }));
  return [{ functionDeclarations }];
}

export const geminiProvider = {
  name: 'gemini',

  /**
   * @param {object} opts
   * @param {string} opts.system
   * @param {{role:'user'|'assistant', content:string}[]} opts.messages
   * @param {object[]} opts.tools - neutral tool spec
   * @param {number} opts.temperature
   * @param {number} opts.maxToolRounds
   * @param {(name:string, args:object)=>Promise<string>} opts.executeTool
   * @returns {Promise<{text:string}>}
   */
  async runConversation({ system, messages, tools, temperature = 0.8, maxToolRounds = 6, executeTool }) {
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const geminiTools = toGeminiTools(tools);
    const client = getClient();
    let response;

    for (let round = 0; round <= maxToolRounds; round++) {
      response = await client.models.generateContent({
        model: config.chatModel,
        contents,
        config: {
          systemInstruction: system,
          ...(geminiTools ? { tools: geminiTools } : {}),
          temperature,
        },
      });

      const calls = response.functionCalls;
      if (!calls || calls.length === 0) break;
      if (!response.candidates?.[0]?.content) break;

      // Echo the model's turn back VERBATIM — newer Gemini models attach a
      // thoughtSignature to functionCall parts and reject requests that drop it.
      contents.push(response.candidates[0].content);

      const responseParts = [];
      for (const call of calls) {
        const result = await executeTool(call.name, call.args || {});
        responseParts.push({ functionResponse: { name: call.name, response: { result } } });
      }
      contents.push({ role: 'user', parts: responseParts });
    }

    return { text: response?.text || '' };
  },
};
