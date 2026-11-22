'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { originMatches, validatePayload, takeQuota, applySecurityHeaders } = require('../lib/notes-security');

const source = 'This study material explains photosynthesis and the conversion of sunlight into stored chemical energy.';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
const req = (body, opts = {}) => ({
  method: 'POST',
  headers: { 'content-type':'application/json', host:'flushcard.vercel.app', origin:'https://flushcard.vercel.app', ...opts.headers },
  body, socket: { remoteAddress:opts.ip || '203.0.113.1' }
});
const check = (body, opts) => validatePayload(req(body,opts));

test('accepts existing flashcard-generation request', () => {
  const out=check({mode:'flashcards', text:source, pages:2,images:[],count:'20',style:'qa',detail:'balanced',difficulty:'intermediate',focus:'',lang:'English'});
  assert.equal(out.data.mode,'flashcards'); assert.equal(out.data.count,20);
});
test('accepts existing notes mode and optional fields',()=>{
  assert.equal(check({mode:'notes',text:source}).data.mode,'notes');
});
test('accepts existing quiz modes and matching count',()=>{
  for(const type of ['mc','tf','fib','typing','ident','enum','match']){
    assert.equal(check({mode:'quiz',type,count:20,text:source}).data.count,20);
  }
});
test('accepts up to eight JPEG page images and empty OCR text',()=>{
  assert.equal(check({mode:'flashcards',text:'',images:Array(8).fill(jpeg)}).data.images.length,8);
});
test('rejects unsupported generation mode',()=>{
  assert.equal(check({mode:'admin',text:source}).status,400);
});
test('rejects empty study text without images',()=>{
  assert.equal(check({mode:'notes',text:'   '}).status,400);
});
test('rejects oversize text rather than silently truncating',()=>{
  assert.equal(check({mode:'notes',text:'x'.repeat(80001)}).status,400);
});
test('rejects unsupported images, invalid Base64 and over eight images',()=>{
  for(const images of [['AAA!'],[Buffer.from('hello').toString('base64')],Array(9).fill(jpeg)]){
    assert.equal(check({mode:'flashcards',text:source,images}).status,400);
  }
});
test('rejects large JSON before Gemini call',()=>{
  assert.equal(check({mode:'flashcards',text:source,other:'x'.repeat(4_000_000)}).status,413);
  assert.equal(check({mode:'notes',text:source},{headers:{'content-length':'4500000'}}).status,413);
});
test('rejects malformed JSON, arrays and invalid content types',()=>{
  assert.equal(validatePayload(req('bad JSON')).status,400);
  assert.equal(check([]).status,400);
  assert.equal(check({mode:'notes',text:source},{headers:{'content-type':'text/plain'}}).status,415);
});
test('rejects invalid counts, type, pages, and overly long settings',()=>{
  for(const body of [
    {mode:'quiz',type:'invalid',text:source},
    {mode:'quiz',type:'mc',count:21,text:source},
    {mode:'flashcards',text:source,count:10000},
    {mode:'flashcards',text:source,pages:-1},
    {mode:'notes',text:source,focus:'x'.repeat(401)},
    {mode:'notes',text:source,lang:'a'.repeat(31)}
  ]) assert.equal(check(body).status,400);
});
test('rejects quiz images but preserves all original quiz types',()=>{
  assert.equal(check({mode:'quiz',text:source,type:'mc',images:[jpeg]}).status,400);
});
test('same-origin browser requests accepted; cross-site origins denied',()=>{
  assert.equal(originMatches(req({})),true);
  assert.equal(originMatches(req({}, {headers:{origin:'https://evil.example'}})),false);
  assert.equal(originMatches(req({}, {headers:{origin:'null'}})),false);
  assert.equal(originMatches(req({}, {headers:{origin:'https://flushcard.vercel.app.evil.example'}})),false);
  assert.equal(originMatches(req({}, {headers:{origin:undefined}})),true);
});
test('CORS response headers restrict to the request origin and disable caching',()=>{
  const headers={}; const response={setHeader(k,v){headers[k.toLowerCase()]=v;}};
  applySecurityHeaders(req({}),response);
  assert.equal(headers['access-control-allow-origin'],'https://flushcard.vercel.app');
  assert.equal(headers['cache-control'],'no-store');
  const cross={}; applySecurityHeaders(req({}, {headers:{origin:'https://evil.example'}}),{setHeader(k,v){cross[k]=v;}});
  assert.equal(cross['Access-Control-Allow-Origin'],undefined);
});
test('local socket address is used instead of untrusted forwarding header',()=>{
  const r=req({}, {ip:'198.51.100.17',headers:{'x-forwarded-for':'1.2.3.4'}});
  const holds=[];
  for(let i=0;i<4;i++){let x=takeQuota(r);assert.equal(x.allowed,true);holds.push(x);}
  const rejected=takeQuota(r); assert.equal(rejected.allowed,false); assert.equal(rejected.retryAfter,5);
  holds.forEach(x=>x.release());
});
test('instance-local quota limits 12 requests per minute and includes Retry-After',()=>{
  const r=req({}, {ip:'198.51.100.92'});
  for(let i=0;i<12;i++) { const x=takeQuota(r,1_000+i);assert.equal(x.allowed,true);x.release(); }
  const limited=takeQuota(r,1_013);assert.equal(limited.allowed,false);assert.ok(limited.retryAfter>=1);
  const renewed=takeQuota(r,61_001);assert.equal(renewed.allowed,true);renewed.release();
});
test('in-flight reservations are released once, safely',()=>{
  const r=req({}, {ip:'198.51.100.93'});
  const hold=takeQuota(r);assert.equal(hold.allowed,true);hold.release();hold.release();
  const second=takeQuota(r);assert.equal(second.allowed,true);second.release();
});
