const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { _testing } = require('../api/fetch-url');
const { checkedUrl, rewriteGoogleUrl, isPublicAddress, createHandler } = _testing;

function response(statusCode, headers = {}, body = 'A'.repeat(250)) {
  return { statusCode, headers, body };
}
function mockNetwork(queue, addressMap = {}) {
  const calls = [];
  let lookups = 0;
  const network = {
    calls,
    get lookups() { return lookups; },
    lookup: async host => {
      lookups++;
      if (!(host in addressMap)) return [{ address: '8.8.8.8', family: 4 }];
      const answer = addressMap[host];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    requestHttp: request,
    requestHttps: request
  };
  function request(url, options, callback) {
    const entry = queue.shift();
    calls.push({ url: url.href, options });
    const req = new EventEmitter();
    req.end = () => {
      if (entry?.timeout) {
        options.signal.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          req.emit('error', err);
        }, { once: true });
        return;
      }
      setImmediate(() => {
        if (entry?.error) return req.emit('error', entry.error);
        const r = entry || response(200, { 'content-type': 'text/plain' });
        const chunks = Array.isArray(r.body) ? r.body : [r.body];
        const stream = Readable.from(chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.statusCode = r.statusCode;
        stream.headers = r.headers;
        callback(stream);
      });
    };
    return req;
  }
  return network;
}
function fakeRes() {
  return {
    headers: {},
    code: null,
    body: null,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(code) { this.code = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; }
  };
}
async function invoke(url, queue, addressMap, options = {}) {
  const n = mockNetwork(queue, addressMap);
  const res = fakeRes();
  await createHandler({ ...n, ...options })({ method: 'POST', body: { url } }, res);
  return { res, network: n };
}

test('blocks private, special-use, and local IPv4 and IPv6 addresses', () => {
  const bad = ['127.0.0.1', '10.1.2.3', '192.168.0.2', '172.18.0.3', '169.254.169.254', '100.64.1.1', '198.18.1.1', '192.0.2.1', '203.0.113.10', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:c0a8:101::1', '2001:db8::1', '3fff::1'];
  for (const ip of bad) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('rejects alternate loopback literals, credentials, bad schemes, custom ports and local names', () => {
  for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://localhost./', 'https://admin:pass@site.org/', 'file:///etc/passwd', 'ftp://public.org/', 'https://site.org:8443/', 'http://host.internal/','https://foo.local/','https://foo.onion/','https://singlelabel/', 'http://site.org\\@127.0.0.1/']) {
    assert.throws(() => checkedUrl(url), undefined, url);
  }
});

test('rewrites only exact Google-host share links, not a matching path on another host', () => {
  assert.equal(rewriteGoogleUrl(checkedUrl('https://docs.google.com/document/d/ABC123/edit')).href, 'https://docs.google.com/document/d/ABC123/export?format=txt');
  assert.equal(rewriteGoogleUrl(checkedUrl('https://docs.google.com/spreadsheets/d/sheet1/edit')).href, 'https://docs.google.com/spreadsheets/d/sheet1/export?format=csv');
  assert.equal(rewriteGoogleUrl(checkedUrl('https://drive.google.com/file/d/file1/view')).href, 'https://drive.google.com/uc?export=download&id=file1');
  assert.equal(rewriteGoogleUrl(checkedUrl('https://other.org/docs.google.com/document/d/ABC123/edit')).href, 'https://other.org/docs.google.com/document/d/ABC123/edit');
});

test('allows a normal HTTPS article, retaining the existing text response contract', async () => {
  const html = '<html><title>Example Title</title><body><script>bad()</script><p>' + 'Study material '.repeat(35) + '</p></body></html>';
  const { res, network } = await invoke('https://news.example.org/article', [response(200, {'content-type': 'text/html'}, html)]);
  assert.equal(res.code, 200);
  assert.equal(res.body.kind, 'text');
  assert.equal(res.body.title, 'Example Title');
  assert.ok(res.body.text.includes('Study material'));
  assert.ok(!res.body.text.includes('bad()'));
  assert.equal(network.calls.length, 1);
  let pinned;
  network.calls[0].options.lookup('news.example.org', {}, (_error, ip, family) => pinned = [ip, family]);
  assert.deepEqual(pinned, ['8.8.8.8', 4]);
  assert.equal(network.lookups, 1, 'the transport must not do a second DNS resolution');
  assert.equal(network.calls[0].options.agent, false);
});

test('supports PDF base64 response and Google Sheets CSV text', async () => {
  const pdf = await invoke('https://public.org/lecture.pdf', [response(200, {'content-type':'application/pdf'}, '%PDF-1.7\nHello')]);
  assert.equal(pdf.res.code, 200);
  assert.equal(pdf.res.body.kind, 'pdf');
  assert.equal(Buffer.from(pdf.res.body.data, 'base64').toString(), '%PDF-1.7\nHello');
  assert.equal(pdf.res.body.name, 'lecture.pdf');
  const csv = await invoke('https://docs.google.com/spreadsheets/d/SHEET/edit', [response(200, {'content-type':'text/csv'}, 'one,two\n'.repeat(50))]);
  assert.equal(csv.res.code, 200);
  assert.equal(csv.res.body.kind, 'text');
  assert.ok(csv.network.calls[0].url.includes('/export?format=csv'));
});

test('blocks internal addresses returned by DNS, including a mixed public/private answer', async () => {
  const { res, network } = await invoke('https://public.org/', [response(200)], {
    'public.org': [{address:'8.8.8.8', family:4}, {address:'10.0.0.5', family:4}]
  });
  assert.equal(res.code, 400);
  assert.equal(network.calls.length, 0);
});

test('validates every redirect and never connects to a private URL', async () => {
  const { res, network } = await invoke('https://public.org/start', [response(302, { location: 'http://127.0.0.1/admin' })]);
  assert.equal(res.code, 400);
  assert.equal(network.calls.length, 1);
});

test('blocks hostname redirect resolving to a private address', async () => {
  const { res, network } = await invoke('https://public.org/start', [response(302,{location:'http://second.org/a'})], {
    'second.org': [{address:'169.254.169.254',family:4}]
  });
  assert.equal(res.code, 400);
  assert.equal(network.calls.length, 1);
});

test('supports safe redirected articles, and enforces the redirect hop cap', async () => {
  const allowed = await invoke('https://public.org/start', [response(302,{ location:'/new' }), response(200,{'content-type':'text/plain'},'A'.repeat(250))]);
  assert.equal(allowed.res.code, 200);
  assert.equal(allowed.network.calls.length, 2);
  const redirect = response(302,{location:'/next'});
  const tooMany = await invoke('https://public.org/start', Array(6).fill(redirect));
  assert.equal(tooMany.res.code, 502);
  assert.equal(tooMany.network.calls.length, 6);
});

test('bounds text and PDF bodies both with and without content-length', async () => {
  const headerLimit = await invoke('https://public.org/file', [response(200,{'content-type':'text/plain','content-length':99999999})]);
  assert.equal(headerLimit.res.code,413);
  const oversized = await invoke('https://public.org/file', [response(200,{'content-type':'text/plain'}, Buffer.alloc(4*1024*1024+1, 65))]);
  assert.equal(oversized.res.code, 413);
  const oversizePdf = await invoke('https://public.org/file.pdf',[response(200,{'content-type':'application/pdf'},Buffer.alloc(15*1024*1024+1,65))]);
  assert.equal(oversizePdf.res.code,413);
});

test('rejects unsupported types, fake PDFs and unexpected compression', async () => {
  const binary = await invoke('https://public.org/file.zip', [response(200,{'content-type':'application/zip'})]);
  assert.equal(binary.res.code, 422);
  const fakePdf = await invoke('https://public.org/file.pdf', [response(200,{'content-type':'application/pdf'},'<html>fake</html>')]);
  assert.equal(fakePdf.res.code, 422);
  const compressed = await invoke('https://public.org/', [response(200,{'content-type':'text/plain','content-encoding':'gzip'})]);
  assert.equal(compressed.res.code, 422);
});

test('returns friendly errors for DNS and network failures, not internal exceptions', async () => {
  const dnsFailure = await invoke('https://public.org/', [], {'public.org':new Error('secret DNS details')});
  assert.equal(dnsFailure.res.code,502);
  assert.ok(!dnsFailure.res.body.error.includes('secret'));
  const network = await invoke('https://public.org/',[{error:new Error('internal socket details')}]);
  assert.equal(network.res.code,502);
  assert.ok(!network.res.body.error.includes('internal'));
});

test('aborts at the shared deadline', async () => {
  const { res } = await invoke('https://public.org/',[{timeout:true}], {}, {timeoutMs:10});
  assert.equal(res.code,504);
  assert.match(res.body.error,/long/i);
});

test('supports only POST and OPTIONS without issuing network requests', async () => {
  const n = mockNetwork([]);
  const handler = createHandler(n);
  const get = fakeRes(); await handler({method:'GET'},get);
  assert.equal(get.code,405);
  const options = fakeRes(); await handler({method:'OPTIONS'},options);
  assert.equal(options.code,204);
  assert.equal(n.calls.length,0);
});


test('preserves Google Drive PDF imports through a binary-content redirect', async () => {
  const { res, network } = await invoke('https://drive.google.com/file/d/ID123/view', [
    response(302, { location: 'https://drive.usercontent.google.com/download?id=ID123' }),
    response(200, { 'content-type': 'application/octet-stream' }, '%PDF-1.6\nPDF file')
  ]);
  assert.equal(res.code, 200);
  assert.equal(res.body.kind, 'pdf');
  assert.equal(res.body.name, 'document.pdf');
  assert.equal(network.calls.length, 2);
});

test('does not wait indefinitely if DNS resolution stalls', async () => {
  const n = mockNetwork([]);
  const res = fakeRes();
  await createHandler({ ...n, lookup: () => new Promise(() => {}), timeoutMs: 10 })(
    { method: 'POST', body: { url: 'https://public.org/' } }, res
  );
  assert.equal(res.code, 504);
  assert.equal(n.calls.length, 0);
});


test('PDF extension remains supported across redirects and unexpected text MIME', async () => {
  const viaRedirect = await invoke('https://public.org/notes.pdf', [
    response(302, { location: '/download?id=1' }),
    response(200, { 'content-type': 'application/octet-stream' }, '%PDF-1.5\nContent')
  ]);
  assert.equal(viaRedirect.res.code, 200);
  assert.equal(viaRedirect.res.body.name, 'notes.pdf');
  const mislabeled = await invoke('https://public.org/notes.pdf', [
    response(200, {'content-type':'text/plain'}, '%PDF-1.7\nContent')
  ]);
  assert.equal(mislabeled.res.code, 200);
  assert.equal(mislabeled.res.body.kind,'pdf');
});
