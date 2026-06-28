/**
 * Netlify Function: cloudinary-delete
 *
 * Accepts a list of Cloudinary public_ids from the frontend and
 * deletes them using the API Secret — which never leaves the server.
 *
 * POST /.netlify/functions/cloudinary-delete
 * Body: { "public_ids": ["folder/abc123", "folder/def456"] }
 *
 * Environment variables required (set in Netlify dashboard):
 *   CLOUDINARY_CLOUD_NAME   — e.g. dqgha35s8
 *   CLOUDINARY_API_KEY      — your Cloudinary API key
 *   CLOUDINARY_API_SECRET   — your Cloudinary API secret (never sent to client)
 */

const crypto = require('crypto');

const ALLOWED_ORIGINS = [
  // Add your production domain(s) here, e.g.:
  // 'https://your-app.netlify.app',
];

/**
 * Generate a Cloudinary API signature for the destroy endpoint.
 * https://cloudinary.com/documentation/authentication_signatures
 */
function signRequest(params, apiSecret) {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map(function (k) { return k + '=' + params[k]; })
    .join('&');
  return crypto
    .createHash('sha256')
    .update(paramString + apiSecret)
    .digest('hex');
}

/**
 * Delete a single asset from Cloudinary.
 * Returns { success: true } or { success: false, error: string }.
 */
async function deleteAsset(publicId, cloudName, apiKey, apiSecret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params    = { public_id: publicId, timestamp: timestamp };
  const signature = signRequest(params, apiSecret);

  const body = new URLSearchParams({
    public_id: publicId,
    timestamp:  timestamp.toString(),
    api_key:   apiKey,
    signature:  signature,
  });

  const url = `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`;

  try {
    const res  = await fetch(url, { method: 'POST', body });
    const data = await res.json();

    if (!res.ok || (data.result !== 'ok' && data.result !== 'not found')) {
      return { success: false, error: data.error?.message || `HTTP ${res.status}` };
    }
    return { success: true, result: data.result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

exports.handler = async function (event) {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Resolve credentials from environment
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    console.error('cloudinary-delete: missing environment variables');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server configuration error' }),
    };
  }

  // Parse body
  let publicIds;
  try {
    const payload = JSON.parse(event.body || '{}');
    publicIds = payload.public_ids;
    if (!Array.isArray(publicIds) || publicIds.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'public_ids must be a non-empty array' }),
      };
    }
  } catch (_) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // Deduplicate and sanitise
  const unique = [...new Set(
    publicIds
      .filter(function (id) { return typeof id === 'string' && id.trim().length > 0; })
      .map(function (id) { return id.trim(); })
  )];

  if (!unique.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No valid public_ids provided' }) };
  }

  // Delete each asset — continue even if one fails (idempotent, tolerant)
  const results = await Promise.all(
    unique.map(function (id) {
      return deleteAsset(id, cloudName, apiKey, apiSecret).then(function (r) {
        if (!r.success) {
          console.warn('cloudinary-delete: failed to delete', id, '—', r.error);
        }
        return { id, ...r };
      });
    })
  );

  const failed  = results.filter(function (r) { return !r.success; });
  const deleted = results.filter(function (r) { return r.success; });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deleted: deleted.length,
      failed:  failed.length,
      results,
    }),
  };
};
