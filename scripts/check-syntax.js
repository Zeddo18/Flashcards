'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const JS_TYPES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript',
  'application/x-javascript', 'text/ecmascript', 'text/javascript',
  'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5',
  'text/jscript', 'text/livescript', 'text/x-ecmascript', 'text/x-javascript'
]);

// Read HTML tags without interpreting > characters inside quoted attributes.
function tagEnd(html, start) {
  let quote = '';
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  throw new Error('Unterminated HTML tag');
}

function attributes(text) {
  const out = new Map();
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of text.matchAll(re)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

function inlineScripts(html) {
  const scripts = [];
  let cursor = 0;
  const tags = /<!--|<([a-z][a-z0-9:-]*)(?=[\s/>])/gi;
  while (cursor < html.length) {
    tags.lastIndex = cursor;
    const tag = tags.exec(html);
    if (!tag) break;
    if (tag[0] === '<!--') {
      const end = html.indexOf('-->', tags.lastIndex);
      cursor = end < 0 ? html.length : end + 3;
      continue;
    }
    const end = tagEnd(html, tags.lastIndex);
    cursor = end + 1;
    const name = tag[1].toLowerCase();
    // These elements contain text, so apparent script tags within are inert.
    if (!['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes'].includes(name)) continue;
    const close = new RegExp('</' + name + '(?=[\\s/>])[^>]*>', 'gi');
    close.lastIndex = cursor;
    const closing = close.exec(html);
    if (!closing) throw new Error('Unterminated ' + name + ' element');
    if (name === 'script') {
      const attrs = attributes(html.slice(tags.lastIndex, end));
      const type = (attrs.get('type') || '').trim().toLowerCase();
      const mime = type.split(';', 1)[0].trim();
      if (!attrs.has('src') && (!type || type === 'module' || JS_TYPES.has(mime))) {
        scripts.push({ code: html.slice(cursor, closing.index),
          mode: type === 'module' ? 'module' : 'commonjs',
          line: html.slice(0, cursor).split('\n').length });
      }
    }
    cursor = close.lastIndex;
  }
  return scripts;
}

function check(code, mode, label) {
  const result = spawnSync(process.execPath, ['--check', '--input-type=' + mode], {
    input: code, encoding: 'utf8', timeout: 30000
  });
  if (result.error) throw new Error(label + ': ' + result.error.message);
  if (result.status !== 0) throw new Error(label + '\n' + (result.stderr || 'Syntax check failed'));
}

function javascriptFiles(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:c|m)?js$/.test(entry.name)) files.push(file);
    }
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) files.push(path.join(root, entry.name));
  }
  for (const dir of ['api', 'lib', 'scripts', 'test']) visit(path.join(root, dir));
  return files.sort();
}

function main(root = path.resolve(__dirname, '..')) {
  const files = javascriptFiles(root);
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error(path.relative(root, file) + '\n' +
      (result.error?.message || result.stderr || 'Syntax check failed'));
  }
  const scripts = inlineScripts(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  for (const script of scripts) check(script.code, script.mode, 'index.html inline script at line ' + script.line);
  console.log('Syntax OK: ' + files.length + ' JavaScript files, ' + scripts.length + ' executable inline scripts.');
}

module.exports = { inlineScripts, check, javascriptFiles, main };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
