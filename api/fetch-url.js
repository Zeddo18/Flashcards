// api/fetch-url.js — bounded article/PDF imports, with SSRF-safe outbound connections.
// No third-party HTTP client: the custom DNS lookup is pinned to the validated IP.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const REQUEST_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2048;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 15 * 1024 * 1024;

const BLOCKED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4'
];
const BLOCKED_V6 = [
  '2001::/23',        // special protocols, including Teredo
  '2001:db8::/32',   // documentation
  '2002::/16',       // 6to4 can embed IPv4 destinations
  '3fff::/20'        // documentation
];

class ImportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function ipv4Number(value) {
  if (net.isIP(value) !== 4) return null;
  return value.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}
function matchesV4(value, cidr) {
  const [base, bits] = cidr.split('/');
  const n = ipv4Number(value);
  if (n === null) return false;
  const mask = bits === '0' ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return ((n & mask) >>> 0) === ((ipv4Number(base) & mask) >>> 0);
}
function ipv6Number(value) {
  const addr = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(addr) !== 6) return null;
  let normalized = addr;
  if (normalized.includes('.')) {
    const at = normalized.lastIndexOf(':');
    const v4 = ipv4Number(normalized.slice(at + 1));
    if (v4 === null) return null;
    normalized = normalized.slice(0, at + 1) +
      ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const count = 8 - left.length - right.length;
  if (halves.length > 2 || (halves.length === 1 && count !== 0) || count < 0) return null;
  const parts = [...left, ...Array(halves.length === 2 ? count : 0).fill('0'), ...right];
  if (parts.length !== 8) return null;
  return parts.reduce((n, part) => (n << 16n) | BigInt(parseInt(part, 16)), 0n);
}
function matchesV6(value, cidr) {
  const [base, bits] = cidr.split('/');
  const n = ipv6Number(value);
  const b = ipv6Number(base);
  if (n === null || b === null) return false;
  const shift = 128n - BigInt(bits);
  return (n >> shift) === (b >> shift);
}
function isPublicAddress(value) {
  const ip = String(value).replace(/^\[|\]$/g, '');
  const family = net.isIP(ip);
  if (family === 4) return !BLOCKED_V4.some(block => matchesV4(ip, block));
  if (family === 6) {
    // Only IPv6 global-unicast ranges may be fetched. This excludes IPv4-mapped,
    // NAT64, ULA, multicast, link-local, loopback, and unspecified addresses.
    return matchesV6(ip, '2000::/3') && !BLOCKED_V6.some(block => matchesV6(ip, block));
  }
  return false;
}
function checkedUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || value.includes('\\')) {
    throw new ImportError(400, 'Send a valid http(s) URL.');
  }
  let url;
  try { url = new URL(value); }
  catch { throw new ImportError(400, 'Send a valid http(s) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ImportError(400, 'Send a valid http(s) URL without embedded credentials.');
  }
  // Custom ports are not needed for article/PDF imports, and substantially
  // widen the reachable infrastructure surface.
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) {
    throw new ImportError(400, 'Only standard HTTP and HTTPS ports are supported.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || host.length > 253 || host.includes('%') || host.includes('\\')) {
    throw new ImportError(400, 'The URL points to an unsupported address.');
  }
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new ImportError(400, 'The URL points to an unsupported address.');
  } else {
    const labels = host.split('.');
    const blockedSuffixes = ['localhost', 'local', 'internal', 'lan', 'home.arpa', 'test', 'invalid', 'onion'];
    if (labels.length < 2 || labels.some(x => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x)) ||
        blockedSuffixes.some(s => host === s || host.endsWith('.' + s))) {
      throw new ImportError(400, 'The URL points to an unsupported address.');
    }
  }
  url.hash = '';
  return url;
}
function rewriteGoogleUrl(url) {
  // Check the URL's actual hostname first: never match a forged domain in a path.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const path = url.pathname;
  const doc = host === 'docs.google.com' && path.match(/^\/document\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (doc) return checkedUrl(`https://docs.google.com/document/d/${doc[1]}/export?format=txt`);
  const sheet = host === 'docs.google.com' && path.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (sheet) return checkedUrl(`https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=csv`);
  const drive = host === 'drive.google.com' && path.match(/^\/file\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (drive) return checkedUrl(`https://drive.google.com/uc?export=download&id=${drive[1]}`);
  return url;
}
function safeFilename(url) {
  let name = url.pathname.split('/').pop() || 'document.pdf';
  try { name = decodeURIComponent(name); } catch { name = 'document.pdf'; }
  name = name.replace(/[\x00-\x1f\x7f/\\]/g, '').replace(/[<>:"|?*]/g, '_').trim();
  if (!/\.pdf$/i.test(name)) name = 'document.pdf';
  return name.slice(0, 80) || 'document.pdf';
}
function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ImportError(504, 'The site took too long to respond.'));
    const onAbort = () => reject(new ImportError(504, 'The site took too long to respond.'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}
function getResponse(url, ip, family, signal, requester) {
  return new Promise((resolve, reject) => {
    const req = requester(url, {
      method: 'GET',
      agent: false,
      autoSelectFamily: false,
      family,
      lookup: (_hostname, _options, done) => done(null, ip, family),
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; FlashcardsBot/1.0)',
        accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,text/csv,*/*',
        'accept-encoding': 'identity'
      },
      signal
    }, resolve);
    req.once('error', reject);
    req.end();
  });
}
async function receiveBody(response, limit) {
  const claimed = Number(response.headers['content-length']);
  if (Number.isFinite(claimed) && claimed > limit) {
    response.destroy();
    throw new ImportError(413, 'That document is too large to import. Download and upload it instead.');
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of response) {
    total += chunk.length;
    if (total > limit) {
      response.destroy();
      throw new ImportError(413, 'That document is too large to import. Download and upload it instead.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
async function download(url, { lookup, requestHttp, requestHttps }, signal) {
  let current = url;
  // Keep the Google Drive PDF export context across usercontent redirects.
  const fromDriveExport = url.hostname.toLowerCase() === 'drive.google.com' && url.pathname === '/uc';
  const originalPdf = /\.pdf$/i.test(url.pathname);
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    if (signal.aborted) throw new ImportError(504, 'The site took too long to respond.');
    current = checkedUrl(current.href);
    const host = current.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    let addresses;
    if (net.isIP(host)) addresses = [{ address: host, family: net.isIP(host) }];
    else {
      try { addresses = await withAbort(Promise.resolve().then(() => lookup(host, { all: true })), signal); }
      catch (error) {
        if (signal.aborted) throw new ImportError(504, 'The site took too long to respond.');
        throw new ImportError(502, 'Could not resolve that website.');
      }
    }
    if (signal.aborted) throw new ImportError(504, 'The site took too long to respond.');
    if (!Array.isArray(addresses) || !addresses.length ||
        !addresses.every(a => (a.family === 4 || a.family === 6) &&
          net.isIP(a.address) === a.family && isPublicAddress(a.address))) {
      throw new ImportError(400, 'The URL points to an unsupported address.');
    }
    // Use precisely this validated IP for the outbound connection: the client
    // must not perform an independent, post-validation DNS lookup.
    const chosen = addresses[0];
    const response = await getResponse(current, chosen.address, chosen.family, signal,
      current.protocol === 'https:' ? requestHttps : requestHttp);
    const status = response.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (typeof location !== 'string' || hops === MAX_REDIRECTS) {
        throw new ImportError(502, 'The website redirected too many times or returned an invalid redirect.');
      }
      let next;
      try { next = new URL(location, current); }
      catch { throw new ImportError(502, 'The website returned an invalid redirect.'); }
      current = checkedUrl(next.href); // Reject private/internal redirect hops.
      continue;
    }
    if (status !== 200) {
      response.destroy();
      throw new ImportError(502, `The site returned HTTP ${status || 'error'}. It may block automated access.`);
    }
    const ct = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
    if (encoding !== 'identity') {
      response.destroy();
      throw new ImportError(422, 'The website returned an unsupported compressed document.');
    }
    const pathPdf = /\.pdf$/i.test(current.pathname);
    const fromGoogleDrive = fromDriveExport || current.hostname.toLowerCase() === 'drive.google.com';
    const declaredPdf = ct === 'application/pdf';
    const pdfCandidate = declaredPdf || pathPdf || originalPdf || fromGoogleDrive;
    const isText = ['text/html', 'text/plain', 'text/csv', 'application/xhtml+xml'].includes(ct);
    if (!pdfCandidate && !isText) {
      response.destroy();
      throw new ImportError(422, 'That URL did not return a supported text or PDF document.');
    }
    const bytes = await receiveBody(response, pdfCandidate ? MAX_PDF_BYTES : MAX_TEXT_BYTES);
    if (pdfCandidate && bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
      return { kind: 'pdf', data: bytes.toString('base64'), name: safeFilename(originalPdf ? url : current) };
    }
    // A claimed PDF or binary download must have a real PDF signature.
    if (declaredPdf || pathPdf || originalPdf || ct === 'application/octet-stream') {
      throw new ImportError(422, 'That URL did not return a valid PDF.');
    }
    if (!isText) throw new ImportError(422, 'That URL did not return a supported text or PDF document.');
    const raw = bytes.toString('utf8');
    const title = ((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [null, ''])[1] || '')
      .replace(/\s+/g, ' ').trim().slice(0, 120) || 'Imported page';
    let body = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    const wp = body.match(/<div[^>]*id=["']mw-content-text["'][^>]*>([\s\S]*?)<div[^>]*class=["'][^"']*printfooter/i);
    if (wp) body = wp[1];
    body = body
      .replace(/<\/(p|div|li|h[1-6]|tr|article|section|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (body.length < 200) throw new ImportError(422, "Couldn't find much readable text on that page.");
    return { kind: 'text', text: body.slice(0, 80000), title };
  }
  throw new ImportError(502, 'The website redirected too many times.');
}

function createHandler(deps = {}) {
  const network = {
    lookup: deps.lookup || dns.promises.lookup,
    requestHttp: deps.requestHttp || http.request,
    requestHttps: deps.requestHttps || https.request
  };
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs || REQUEST_TIMEOUT_MS);
    try {
      const url = rewriteGoogleUrl(checkedUrl(req.body && req.body.url));
      const value = await download(url, network, controller.signal);
      return res.status(200).json(value);
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') {
        return res.status(504).json({ error: 'The site took too long to respond.' });
      }
      if (error instanceof ImportError) return res.status(error.status).json({ error: error.message });
      // Do not return stack traces, socket errors, or private hostnames to callers.
      return res.status(502).json({ error: 'Could not fetch that URL. The website may be unavailable.' });
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = createHandler();
// Narrow injection seam for isolated tests without live network calls.
module.exports._testing = { createHandler, checkedUrl, rewriteGoogleUrl, isPublicAddress };
