// ─────────────────────────────────────────────────────────────────────────────
// netlify/functions/stt.js
// ALEEM AI — Speech-to-Text via Groq Whisper
//
// Endpoint : POST /.netlify/functions/stt
// Accepts  : multipart/form-data  →  field name "audio"  (any browser audio blob)
// Returns  : { "transcript": "..." }          on success  (HTTP 200)
//            { "error": "...", "detail": "..." } on failure  (HTTP 4xx / 5xx)
//
// Environment variable required (already set in Netlify):
//   GROQ_API_KEY
//
// Groq model used:
//   whisper-large-v3-turbo
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { default: Groq, toFile } = require('groq-sdk');
const busboy = require('busboy');
const { Readable } = require('stream');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse the first "audio" field out of a multipart/form-data request.
 * Returns a Promise that resolves to:
 *   { buffer: Buffer, filename: string, mimeType: string }
 */
function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';

    if (!contentType.includes('multipart/form-data')) {
      return reject(new Error('Content-Type must be multipart/form-data'));
    }

    const bb = busboy({ headers: { 'content-type': contentType } });

    let resolved = false;

    bb.on('file', (fieldname, fileStream, info) => {
      if (fieldname !== 'audio') {
        // Drain and ignore unexpected fields.
        fileStream.resume();
        return;
      }

      const { filename, mimeType } = info;
      const chunks = [];

      fileStream.on('data', (chunk) => chunks.push(chunk));
      fileStream.on('end', () => {
        if (!resolved) {
          resolved = true;
          resolve({
            buffer  : Buffer.concat(chunks),
            filename: filename || 'audio.webm',
            mimeType: mimeType || 'audio/webm',
          });
        }
      });
      fileStream.on('error', reject);
    });

    bb.on('finish', () => {
      if (!resolved) {
        reject(new Error('No "audio" field found in the multipart body.'));
      }
    });

    bb.on('error', reject);

    // Netlify functions provide the body as a base64 string when
    // isBase64Encoded is true, otherwise as a plain string.
    const bodyBuffer = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body || '', 'binary');

    // Pipe the body buffer through busboy via a Node.js Readable stream.
    const readable = new Readable();
    readable.push(bodyBuffer);
    readable.push(null);
    readable.pipe(bb);
  });
}

/**
 * Build a JSON HTTP response.
 */
function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type' : 'application/json',
      // Allow calls from the same Netlify origin and localhost during testing.
      'Access-Control-Allow-Origin' : '*',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(body),
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async function handler(event) {

  // ── CORS pre-flight ───────────────────────────────────────────────────────
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin' : '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  // ── Only POST is accepted ─────────────────────────────────────────────────
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed', detail: 'Use POST.' });
  }

  // ── API key guard ─────────────────────────────────────────────────────────
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('[stt] GROQ_API_KEY environment variable is not set.');
    return json(500, {
      error : 'Server configuration error',
      detail: 'GROQ_API_KEY is not configured.',
    });
  }

  // ── Parse audio from multipart body ──────────────────────────────────────
  let audioBuffer, audioFilename, audioMimeType;
  try {
    ({ buffer: audioBuffer, filename: audioFilename, mimeType: audioMimeType } =
      await parseMultipart(event));
  } catch (parseErr) {
    console.error('[stt] Multipart parse error:', parseErr.message);
    return json(400, {
      error : 'Bad request',
      detail: parseErr.message,
    });
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    return json(400, { error: 'Bad request', detail: 'Audio buffer is empty.' });
  }

  // ── Call Groq Whisper ─────────────────────────────────────────────────────
  try {
    const groq = new Groq({ apiKey });

    // toFile() is exported directly from groq-sdk and works on Node 18, 20,
    // and 22 without relying on the global File constructor (which was only
    // stabilised as a global in Node 20). It accepts a Buffer natively.
    const audioFile = await toFile(audioBuffer, audioFilename, { type: audioMimeType });

    const transcription = await groq.audio.transcriptions.create({
      file             : audioFile,
      model            : 'whisper-large-v3-turbo',
      response_format  : 'json',   // returns { text: "..." }
      // language is intentionally omitted → Whisper auto-detects
    });

    const transcript = (transcription.text || '').trim();

    console.log('[stt] OK — chars:', transcript.length);

    return json(200, { transcript });

  } catch (groqErr) {
    console.error('[stt] Groq API error:', groqErr.message);

    // Surface the Groq HTTP status when available.
    const status = groqErr.status || 502;
    return json(status >= 400 && status < 600 ? status : 502, {
      error : 'Groq API error',
      detail: groqErr.message || 'Unknown error from Groq.',
    });
  }
};
      
