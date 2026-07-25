/**
 * Replicate chat provider (DeepSeek-V3.1 and other text LLMs).
 *
 * The Replicate deployment exposes a FLAT `prompt` completion interface
 * (no messages/system/tools fields) whose output is a token-array of strings,
 * prefixed by a `</think>` reasoning block. So this provider:
 *   1. Serializes system + tool protocol + the whole conversation into one prompt.
 *   2. Runs tools through an in-prompt JSON protocol (§TOOL … / §RESULT …),
 *      looping like the native Gemini tool loop.
 *   3. Strips the model's reasoning (everything up to the last </think>).
 *
 * Text only — voice-note transcription stays on Gemini in chat-session.
 * Auth: REPLICATE_API_TOKEN. Delivery via HTTP with `Prefer: wait` (+ polling).
 */
import config from '../../config.js';
import logger from '../../utils/logger.js';

const API = 'https://api.replicate.com/v1';
const TOOL_MARKER = '§TOOL';
const RESULT_MARKER = '§RESULT';

// ─── Prompt construction ───────────────────────────────────────────
function toolProtocol(tools) {
  if (!tools || tools.length === 0) return '';
  const lines = [
    '',
    '=== BACK-OFFICE TOOLS (the user never sees these) ===',
    `When you want to use one or more tools, your ENTIRE reply for that turn must be exactly one line:`,
    `${TOOL_MARKER} {"calls":[{"name":"<tool_name>","arguments":{ ... }}]}`,
    `and NOTHING else — no greeting, no explanation. The system runs the tools and appends "${RESULT_MARKER} ..." with the results, then you continue.`,
    `When you are ready to talk to the user instead, write ONLY your normal WhatsApp message (never write ${TOOL_MARKER} in that case).`,
    `Never put both a ${TOOL_MARKER} line and a user message in the same reply.`,
    'Available tools:',
  ];
  for (const t of tools) {
    const args = Object.entries(t.parameters || {})
      .map(([k, v]) => `${k}${(t.required || []).includes(k) ? '*' : ''} (${v.type}): ${v.description}`)
      .join('; ');
    lines.push(`- ${t.name} — ${t.description} | args: ${args || 'none'}`);
  }
  lines.push('(* = required)');
  lines.push('=== END TOOLS ===');
  return lines.join('\n');
}

function buildPrompt(system, turns, tools) {
  const parts = [
    system,
    toolProtocol(tools),
    '',
    'Below is the conversation so far. Write ONLY the assistant\'s next reply (or a ' + TOOL_MARKER + ' line). Do not prefix it with "Assistant:".',
    '',
  ];
  for (const t of turns) {
    const who = t.role === 'assistant' ? 'Assistant' : 'User';
    parts.push(`${who}: ${t.content}`);
  }
  parts.push('Assistant:');
  return parts.join('\n');
}

// ─── Output parsing ────────────────────────────────────────────────
/** Remove the model's reasoning: everything up to and including the last </think>. */
function stripReasoning(text) {
  let t = String(text || '');
  const idx = t.lastIndexOf('</think>');
  if (idx !== -1) t = t.slice(idx + '</think>'.length);
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '');
  return t.trim();
}

/** Extract tool calls from a model reply, or null. Handles our §TOOL protocol
 *  (including MULTIPLE §TOOL lines in one reply — models do this despite
 *  instructions), fenced/loose JSON, and DeepSeek's native token format. */
function extractToolCalls(text) {
  // 1. Our protocol — parse EVERY §TOOL occurrence, line by line first
  const collected = [];
  for (const line of text.split('\n')) {
    const idx = line.indexOf(TOOL_MARKER);
    if (idx === -1) continue;
    const calls = parseCallsJson(line.slice(idx + TOOL_MARKER.length));
    if (calls) collected.push(...calls);
  }
  if (collected.length) return collected;

  // Single marker with the JSON spilling across lines
  const markerIdx = text.indexOf(TOOL_MARKER);
  if (markerIdx !== -1) {
    const calls = parseCallsJson(text.slice(markerIdx + TOOL_MARKER.length));
    if (calls) return calls;
  }
  // 2. Native DeepSeek token format
  if (text.includes('tool▁call') || text.includes('tool_call_begin') || text.includes('｜tool')) {
    const native = parseNativeToolCalls(text);
    if (native.length) return native;
  }
  // 3. Loose JSON containing calls/tool_calls (fenced or inline)
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const calls = parseCallsJson(fenced ? fenced[1] : text);
  if (calls) return calls;
  return null;
}

/** True if the reply contains tool-protocol residue that must never be sent. */
export function containsToolProtocol(text) {
  return text.includes(TOOL_MARKER) || text.includes(RESULT_MARKER) || text.includes('§');
}

/** Balanced-brace scan: extract the first complete JSON object in `s`. */
function firstJsonObject(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseCallsJson(s) {
  const jsonStr = firstJsonObject(s);
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr);
    const arr = obj.calls || obj.tool_calls;
    if (Array.isArray(arr) && arr.length) {
      return arr
        .map(c => ({ name: c.name, arguments: c.arguments || c.args || c.parameters || {} }))
        .filter(c => c.name);
    }
    // Single-call shape: {"name":"...","arguments":{...}}
    if (obj.name && (obj.arguments || obj.args)) {
      return [{ name: obj.name, arguments: obj.arguments || obj.args || {} }];
    }
  } catch { /* not valid JSON */ }
  return null;
}

function parseNativeToolCalls(text) {
  // <｜tool▁call▁begin｜>name<｜tool▁sep｜>{args}<｜tool▁call▁end｜>
  const out = [];
  const re = /([a-z_][a-z0-9_]*)[^\{]*?(\{[\s\S]*?\})/gi;
  const region = text.replace(/｜|▁/g, ' '); // normalize special separators to spaces
  let m;
  while ((m = re.exec(region)) !== null) {
    try {
      out.push({ name: m[1], arguments: JSON.parse(m[2]) });
    } catch { /* skip */ }
  }
  return out;
}

// ─── Replicate HTTP ────────────────────────────────────────────────
async function predict(prompt) {
  if (!config.replicate.apiToken) throw new Error('REPLICATE_API_TOKEN is not set');
  const input = {
    prompt,
    max_tokens: config.replicate.maxTokens,
    temperature: config.replicate.temperature,
    top_p: 0.95,
  };

  const res = await fetch(`${API}/models/${config.replicate.model}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.replicate.apiToken}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(75_000),
  });

  let pred = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = pred?.detail || JSON.stringify(pred).slice(0, 300);
    throw new Error(`Replicate ${res.status}: ${detail}`);
  }

  // Poll if `Prefer: wait` returned before completion
  let tries = 0;
  while (pred && !['succeeded', 'failed', 'canceled'].includes(pred.status) && pred.urls?.get && tries < 40) {
    await new Promise(r => setTimeout(r, 1500));
    const p = await fetch(pred.urls.get, { headers: { Authorization: `Bearer ${config.replicate.apiToken}` } });
    pred = await p.json();
    tries += 1;
  }
  if (pred.status !== 'succeeded') {
    throw new Error(`Replicate prediction ${pred.status}: ${pred.error || 'no output'}`);
  }
  const out = pred.output;
  return Array.isArray(out) ? out.join('') : String(out ?? '');
}

export const replicateProvider = {
  name: 'replicate',

  async runConversation({ system, messages, tools, maxToolRounds = 6, executeTool }) {
    const turns = [...messages];
    let finalText = '';

    for (let round = 0; round <= maxToolRounds; round++) {
      const prompt = buildPrompt(system, turns, tools);
      const raw = await predict(prompt);
      const reply = stripReasoning(raw);
      const calls = extractToolCalls(reply);

      if (!calls) {
        // HARD GUARANTEE: if the reply contains any tool-protocol residue we
        // couldn't parse, suppress the whole turn — never send it to a lead.
        if (containsToolProtocol(reply)) {
          logger.warn({ preview: reply.slice(0, 120) },
            'Replicate reply contained unparseable tool protocol — suppressed');
          finalText = '';
          break;
        }
        finalText = reply;
        break;
      }

      // Record the tool-call turn + results, then loop (no user-facing text this round)
      turns.push({ role: 'assistant', content: `${TOOL_MARKER} ${JSON.stringify({ calls })}` });
      const results = [];
      for (const call of calls) {
        try {
          const result = await executeTool(call.name, call.arguments || {});
          results.push({ name: call.name, result });
        } catch (err) {
          results.push({ name: call.name, result: `error: ${err.message}` });
        }
      }
      turns.push({ role: 'user', content: `${RESULT_MARKER} ${JSON.stringify(results)}` });

      if (round === maxToolRounds) {
        logger.warn('Replicate tool loop hit max rounds without a final reply');
      }
    }

    return { text: finalText };
  },
};
