// netlify/functions/chat.js
// ALEEM AI — Secure Gemini API proxy
// The API key never leaves this server-side function.

const FALLBACK_MODELS = [];

// [ADDED] Valid models the frontend model selector can choose from.
// If the incoming `model` field matches one of these, it is used as the
// preferred model. Any unrecognised value falls back to gemini-2.5-flash.
const SELECTABLE_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'];
// [END ADDED]

exports.handler = async function (event) {
  // ── CORS preflight ──────────────────────────────────────────────
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: '',
    };
  }

  // ── Only allow POST ─────────────────────────────────────────────
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  // ── Read API key from environment ───────────────────────────────
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GEMINI_KEY) {
    console.error('GEMINI_API_KEY environment variable is not set');
    return json(500, {
      error: {
        code: 500,
        status: 'CONFIGURATION_ERROR',
        message:
          'The server is missing its Gemini API key. ' +
          'Please set the GEMINI_API_KEY environment variable in Netlify.',
      },
    });
  }

  // ── Parse request body ──────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { model, geminiBody, action } = body;

  // ── Action: "test" — quick connection test ──────────────────────
  if (action === 'test') {
    const testBody = {
      contents: [{ role: 'user', parts: [{ text: 'Reply with only the word: OK' }] }],
      generationConfig: { maxOutputTokens: 5, temperature: 0 },
    };
    const result = await callGemini('gemini-2.5-flash', testBody, GEMINI_KEY);
    return json(result.status, result.data);
  }

  // ── Action: "chat" (default) ────────────────────────────────────
  if (!geminiBody) {
    return json(400, { error: 'Missing geminiBody in request' });
  }

  // Build model queue: preferred first, then fallbacks
  // [MODIFIED] Check against SELECTABLE_MODELS so both 'gemini-2.5-flash' and
  // 'gemini-2.5-pro' are honoured. Unrecognised values fall back to gemini-2.5-flash.
  const preferred = model && SELECTABLE_MODELS.includes(model) ? model : 'gemini-2.5-flash-lite';
  const modelQueue = [preferred, ...FALLBACK_MODELS.filter((m) => m !== preferred)];
  // [END MODIFIED]

  let lastResult = null;

  for (const m of modelQueue) {
    const result = await callGemini(m, geminiBody, GEMINI_KEY);
    lastResult = result;

    if (result.status === 200) {
      // Success — return with which model was used
      return json(200, { ...result.data, _model_used: m });
    }

    // Decide whether to try next model or bail immediately
    const errStatus = result.data?.error?.status || '';
    const errCode   = result.data?.error?.code;
    const errMsg    = result.data?.error?.message || '';

    const isFatal =
      errCode === 400 ||
      errCode === 401 ||
      errCode === 403 ||
      errStatus === 'INVALID_ARGUMENT' ||
      errStatus === 'PERMISSION_DENIED' ||
      errStatus === 'UNAUTHENTICATED' ||
      (errCode === 429 && (errMsg.includes('limit: 0') || errMsg.includes('free_tier')));

    if (isFatal) {
      // No point trying other models for auth/key errors
      return json(result.status, result.data);
    }

    // 503 or rate-limit — try next model
    console.log(`Model ${m} returned ${result.status}, trying next fallback…`);
  }

  // Gemini failed, try Groq
  console.log('Trying Groq fallback...');
if (GROQ_KEY) {
    // Build a proper messages array from the full geminiBody contents,
    // converting Gemini roles ('model') to OpenAI roles ('assistant').
    // Also prepend the system instruction if present.
    const groqMessages = [];
    if (geminiBody.system_instruction?.parts?.[0]?.text) {
        groqMessages.push({
            role: 'system',
            content: geminiBody.system_instruction.parts[0].text
        });
    }
    (geminiBody.contents || []).forEach(function(c) {
        groqMessages.push({
            role: c.role === 'model' ? 'assistant' : 'user',
            content: c.parts?.[0]?.text || ''
        });
    });

    const groqResult = await callGroq(groqMessages, GROQ_KEY);

    if (groqResult.status === 200) {
        return json(200, {
            candidates: [{
                content: {
                    parts: [{
                        text: groqResult.data.choices[0].message.content
                    }]
                }
            }],
            _model_used: 'groq'
        });
    }
}

// All models exhausted
return json(lastResult?.status || 503, lastResult?.data || {
    error: {
        code: 503,
        message: 'Gemini and Groq are currently unavailable.'
    }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function callGemini(model, body, apiKey) {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    model +
    ':generateContent?key=' +
    apiKey;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
  } catch (err) {
    console.error('Gemini fetch error:', err.message);
    return {
      status: 503,
      data: {
        error: { code: 503, status: 'NETWORK_ERROR', message: err.message },
      },
    };
  }
}

async function callGroq(messages, apiKey) {
  try {
    const res = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: messages
        })
      }
    );

    const data = await res.json();

    return {
      status: res.status,
      data
    };
  } catch (err) {
    return {
      status: 500,
      data: {
        error: err.message
      }
    };
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body),
  };
}
  
};
  
