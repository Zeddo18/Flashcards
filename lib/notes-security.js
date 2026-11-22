'use strict';

// Input safeguards for the public Gemini-backed generation endpoint.
// This is an *instance-local* rate limiter, NOT a substitute for a distributed
// platform firewall rule. Vercel may run multiple isolated instances.
const { isIP } = require('node:net');

const MAX_BODY_BYTES = 4_000_000; // Below Vercel's standard 4.5 MB payload ceiling.
const MAX_TEXT_LENGTH = 80_000;
const MAX_IMAGE_CHARS = 1_400_000;
const MAX_IMAGES = 8;
const WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 12;
const MAX_BUCKETS = 2048;
const MAX_INFLIGHT = 4;
const buckets = new Map();
let inflight = 0;

const invalid = (status, error) => ({ status, error });
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);

function originMatches(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    const host = req.headers?.host;
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.username === '' && parsed.password === '' &&
      parsed.pathname === '/' && parsed.search === '' && parsed.hash === '' &&
      typeof host === 'string' && parsed.host.toLowerCase() === host.toLowerCase();
  } catch { return false; }
}

function requestIp(req) {
  // On Vercel, proxy-controlled x-forwarded-for is overwritten at the edge.
  // Do not trust client-supplied forwarding headers in local/non-Vercel setups.
  const forwarded = process.env.VERCEL === '1'
    ? req.headers?.['x-vercel-forwarded-for'] || req.headers?.['x-forwarded-for']
    : null;
  const candidate = typeof forwarded === 'string' ? forwarded.trim() : req.socket?.remoteAddress;
  return typeof candidate === 'string' && isIP(candidate) ? candidate : 'instance-unknown';
}

function takeQuota(req, now = Date.now()) {
  const identity = requestIp(req);
  let times = buckets.get(identity);
  if (!times) {
    if (buckets.size >= MAX_BUCKETS) {
      for (const [key, entries] of buckets) {
        if (!entries.length || entries[entries.length - 1] <= now - WINDOW_MS) buckets.delete(key);
      }
      // Evict the oldest bucket if all are still active; bounded memory wins.
      if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
    }
    times = [];
    buckets.set(identity, times);
  }
  while (times.length && times[0] <= now - WINDOW_MS) times.shift();
  if (times.length >= REQUESTS_PER_WINDOW) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((times[0] + WINDOW_MS - now) / 1000)) };
  }
  // Fail closed for over-capacity workers before making an upstream API call.
  if (inflight >= MAX_INFLIGHT) return { allowed: false, retryAfter: 5 };
  times.push(now);
  inflight++;
  let done = false;
  return { allowed: true, release() { if (!done) { done = true; inflight--; } } };
}

function checkOptionalString(body, key, allowedLength, allowedValues) {
  if (body[key] === undefined || body[key] === null || body[key] === '') return true;
  if (typeof body[key] !== 'string' || body[key].length > allowedLength) return false;
  return !allowedValues || allowedValues.includes(body[key]);
}

function validatePayload(req) {
  const contentType = req.headers?.['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    return invalid(415, 'Send a JSON request.');
  }
  const suppliedLength = req.headers?.['content-length'];
  if (suppliedLength !== undefined && (!/^\d+$/.test(String(suppliedLength)) || Number(suppliedLength) > MAX_BODY_BYTES)) {
    return invalid(413, 'The request is too large. Try fewer pages or images.');
  }

  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return invalid(413, 'The request is too large. Try fewer pages or images.');
    try { body = JSON.parse(body); } catch { return invalid(400, 'Invalid JSON request.'); }
  }
  if (!isRecord(body)) return invalid(400, 'Invalid request data.');
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(body), 'utf8'); }
  catch { return invalid(400, 'Invalid request data.'); }
  if (bytes > MAX_BODY_BYTES) return invalid(413, 'The request is too large. Try fewer pages or images.');

  const mode = body.mode;
  if (!['flashcards', 'notes', 'quiz'].includes(mode)) return invalid(400, 'Unsupported generation mode.');
  const text = body.text === undefined ? '' : body.text;
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) return invalid(400, 'Study material is too long (maximum 80,000 characters).');

  const images = body.images === undefined ? [] : body.images;
  if (!Array.isArray(images) || images.length > MAX_IMAGES) return invalid(400, 'Upload up to eight supported page images.');
  for (const image of images) {
    if (typeof image !== 'string' || !image.length || image.length > MAX_IMAGE_CHARS || image.length % 4 !== 0 ||
      !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(image)) {
      return invalid(400, 'Invalid page image. Use JPEG images.');
    }
    const signature = Buffer.from(image.slice(0, 8), 'base64');
    if (signature.length < 3 || signature[0] !== 0xff || signature[1] !== 0xd8 || signature[2] !== 0xff) {
      return invalid(400, 'Invalid page image. Use JPEG images.');
    }
  }
  if (mode === 'quiz' && (!text.trim() || images.length)) return invalid(400, 'Quiz source must be text.');
  if (mode !== 'quiz' && text.trim().length < 50 && !images.length) return invalid(400, 'Provide more study material or readable page images.');

  const allowedTypes = ['mc', 'tf', 'fib', 'typing', 'ident', 'enum', 'match'];
  if (mode === 'quiz' && !allowedTypes.includes(body.type)) return invalid(400, 'Unsupported quiz type.');
  const allowed = [
    ['focus', 400], ['lang', 30], ['style', 20, ['qa', 'cloze', 'tf']],
    ['difficulty', 20, ['beginner', 'intermediate', 'advanced']],
    ['detail', 20, ['concise', 'balanced', 'detailed']]
  ];
  for (const [key, max, values] of allowed) {
    if (!checkOptionalString(body, key, max, values)) return invalid(400, 'Invalid ' + key + ' option.');
  }
  const count = body.count === undefined ? (mode === 'quiz' ? 10 : 20) : Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > (mode === 'quiz' ? 20 : 40)) {
    return invalid(400, 'Invalid question or card count.');
  }
  const pages = body.pages === undefined ? 1 : Number(body.pages);
  if (!Number.isInteger(pages) || pages < 1 || pages > 100000) return invalid(400, 'Invalid page count.');
  return { data: { ...body, text, images, mode, count, pages } };
}

function applySecurityHeaders(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
  if (originMatches(req) && typeof req.headers?.origin === 'string') {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
  }
}

// Internal visibility for deterministic focused tests only (no user data stored).
module.exports = { originMatches, validatePayload, takeQuota, applySecurityHeaders };
