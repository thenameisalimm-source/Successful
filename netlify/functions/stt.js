// netlify/functions/stt.js
//
// ── AUDIT NOTES ──────────────────────────────────────────────────────────────
//
// This is the reference implementation for the /.netlify/functions/stt endpoint.
// Compare every line against your live file to verify the language parameter
// reaches Groq.
//
// WHAT TO CHECK IN YOUR LIVE FILE:
//
//   1. FormData parsing — confirm `formData.get('language')` (or equivalent)
//      is actually called. If the field is never read, it is silently dropped.
//
//   2. Groq API body — confirm the parsed language value appears in the JSON
//      body sent to Groq's transcription endpoint. The field name Groq expects
//      is exactly "language" (lowercase). It must be an ISO 639-1 code:
//        hi  — Hindi
//        mr  — Marathi
//        gu  — Gujarati
//        ur  — Urdu
//        en  — English
//      Any other value (e.g. "hi-IN", "auto", "", undefined) causes Groq/Whisper
//      to fall back to automatic language detection.
//
//   3. No empty-string passthrough — if language is '' (Auto mode), the field
//      must be OMITTED from the Groq request entirely, not passed as an empty
//      string. Groq treats "" as an invalid language and may default to English.
//
// ─────────────────────────────────────────────────────────────────────────────

const Groq = require('groq-sdk');   // or: const { Groq } = require('groq-sdk');
const Busboy = require('busboy');

// ── Server-side timeout budget ──────────────────────────────────────────────
// Client aborts at STT_TIMEOUT_MS = 12000ms (index.html). 4s + 6s = 10s,
// leaving ~2s margin so a JSON error always beats the client's own timeout.
const PARSE_TIMEOUT_MS = 4000;
const GROQ_TIMEOUT_MS  = 6000;

// Races any promise against a hard deadline. Does not depend on the losing
// promise actually cancelling its own work — it just stops waiting on it,
// which is what guarantees this function responds in time regardless of
// what parseForm/Groq are doing internally.
function withTimeout(promise, ms, label) {
  return new Promise(function(resolve, reject) {
    var t = setTimeout(function() {
      reject(new Error(label + ' timed out after ' + ms + 'ms'));
    }, ms);
    promise.then(
      function(v) { clearTimeout(t); resolve(v); },
      function(e) { clearTimeout(t); reject(e); }
    );
  });
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // ── Parse multipart/form-data ─────────────────────────────────
    console.log('[STT] stage=parseForm:start');
    const { audioBuffer, audioMime, language } = await withTimeout(parseForm(event), PARSE_TIMEOUT_MS, 'parseForm');
    console.log('[STT] stage=parseForm:done');

    // ── AUDIT POINT 1: Log what the frontend actually sent ────────
    // Check your Netlify function logs for this line.
    // "language" must be a 2-letter ISO 639-1 code ("hi", "gu", "mr", "ur", "en")
    // or undefined/empty for Auto mode.
    console.log('[STT] language param received:', JSON.stringify(language));
    console.log('[STT] audio size:', audioBuffer.length, 'bytes');

    // ── Build Groq transcription request ─────────────────────────
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: GROQ_TIMEOUT_MS, maxRetries: 0 });

    // The audio field must be a File-like object. Groq SDK accepts a Blob
    // or a File. We reconstruct one from the raw buffer.
    const audioBlob = new Blob([audioBuffer], { type: audioMime || 'audio/webm' });
    const audioFile = new File([audioBlob], 'audio.webm', { type: audioMime || 'audio/webm' });

    // ── Build params — only include `language` when it is a valid code ──
    const transcriptionParams = {
      file:             audioFile,
      model:            'whisper-large-v3',
      response_format:  'json',
      temperature:      0,
    };

    // ── AUDIT POINT 2: Language field forwarded to Groq ──────────
    // Only pass `language` when we have a non-empty ISO 639-1 code.
    // Passing an empty string ("") causes Groq to silently ignore it
    // and auto-detect — same as the BCP-47 bug on the frontend.
    const cleanLang = (language || '').trim().split('-')[0].toLowerCase();
    if (cleanLang && cleanLang.length >= 2 && cleanLang.length <= 3) {
      transcriptionParams.language = cleanLang;
      console.log('[STT] Forwarding language to Groq:', cleanLang, '— auto-detection DISABLED');
    } else {
      console.log('[STT] No valid language code — Groq will auto-detect');
    }

    // ── AUDIT POINT 3: Log the exact Groq params (minus the file) ──
    console.log('[STT] Groq params:', JSON.stringify({
      model:    transcriptionParams.model,
      language: transcriptionParams.language,      // undefined if auto
      response_format: transcriptionParams.response_format,
      temperature:     transcriptionParams.temperature,
    }));

    // ── Call Groq ─────────────────────────────────────────────────
    console.log('[STT] stage=groq:start');
    const result = await withTimeout(
      groq.audio.transcriptions.create(transcriptionParams),
      GROQ_TIMEOUT_MS,
      'groq.transcriptions.create'
    );
    console.log('[STT] stage=groq:done');

    console.log('[STT] Groq transcript:', JSON.stringify(result.text));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: result.text || '' }),
    };

  } catch (err) {
    console.error('[STT] Error:', err.message, err.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message, transcript: '' }),
    };
  }
};

// ── Multipart parser ──────────────────────────────────────────────────────────
function parseForm(event) {
  return new Promise(function(resolve, reject) {
    const chunks  = [];
    let   mime    = 'audio/webm';
    let   lang    = '';

    const busboy = Busboy({
      headers: {
        'content-type': event.headers['content-type'] || event.headers['Content-Type'],
      },
    });

    busboy.on('file', function(fieldname, file, info) {
      mime = info.mimeType || mime;
      file.on('data', function(d) { chunks.push(d); });
    });

    busboy.on('field', function(fieldname, value) {
      // ── AUDIT POINT 4: Confirm 'language' field is actually read here ──
      if (fieldname === 'language') {
        lang = value;
        console.log('[STT:parseForm] language field read from FormData:', JSON.stringify(lang));
      }
    });

    busboy.on('close', function() {
      resolve({
        audioBuffer: Buffer.concat(chunks),
        audioMime:   mime,
        language:    lang,
      });
    });

    busboy.on('error', reject);

    // Netlify passes the body as base64 when isBase64Encoded is true
    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body || '', 'utf8');

    busboy.write(body);
    busboy.end();
  });
}
