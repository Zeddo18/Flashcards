'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inlineScripts, check, javascriptFiles } = require('../scripts/check-syntax');
const path = require('node:path');

test('inline checker checks classic JavaScript and reports invalid syntax', () => {
  const [script] = inlineScripts('<script>const value = 1;</script>');
  check(script.code, script.mode, 'valid classic');
  assert.throws(() => check('const = ;', 'commonjs', 'broken classic'), /broken classic[\s\S]*SyntaxError/);
  assert.throws(() => check('export const value = 1;', 'commonjs', 'classic export'), /SyntaxError/);
  assert.throws(() => check('return 1;', 'commonjs', 'classic return'), /SyntaxError/);
});

test('module scripts support imports, exports and top-level await without execution', () => {
  const [script] = inlineScripts('<SCRIPT TYPE=" module ">import x from "missing-package"; export const y = await x();</SCRIPT>');
  assert.equal(script.mode, 'module');
  check(script.code, script.mode, 'module');
  assert.throws(() => check('export const = ;', 'module', 'broken module'), /SyntaxError/);
});

test('JSON and other data blocks are excluded from JavaScript parsing', () => {
  for (const type of ['application/json', 'application/ld+json', 'importmap', 'speculationrules', 'text/plain', 'unknown/type']) {
    assert.deepEqual(inlineScripts('<script type="' + type + '">{"not":"JavaScript"}</script>'), []);
  }
});

test('external scripts are skipped even when src is empty or has no value', () => {
  for (const attr of ['src="app.js"', 'SRC=""', 'src']) {
    assert.deepEqual(inlineScripts('<script ' + attr + '>invalid inline</script>'), []);
  }
});

test('script attributes handle MIME types, quoted delimiters and duplicate attributes', () => {
  for (const attr of ['', 'type=""', 'type="TEXT/JAVASCRIPT; charset=utf-8"', "type='application/javascript'", 'type=text/ecmascript']) {
    assert.equal(inlineScripts('<script data-label="a > b" ' + attr + '>let ok;</script>').length, 1);
  }
  assert.equal(inlineScripts('<script type="application/json" type="text/javascript">data</script>').length, 0);
});

test('comments, text elements and quoted HTML attributes cannot introduce fake scripts', () => {
  const fake = '<script>invalid code !</script>';
  assert.deepEqual(inlineScripts('<!--' + fake + '--><div title="' + fake + '"></div>'), []);
  for (const tag of ['style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']) {
    assert.deepEqual(inlineScripts('<' + tag + '>' + fake + '</' + tag + '>'), []);
  }
  const scripts = inlineScripts('\n<script>const a = "<script>";</script>\n<script>let b;</script>');
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0].line, 2);
  assert.equal(scripts[1].line, 3);
  assert.throws(() => inlineScripts('<script>unfinished'), /Unterminated script/);
});

test('syntax discovery includes production, test and checker JavaScript', () => {
  const root = path.resolve(__dirname, '..');
  const files = javascriptFiles(root).map(file => path.relative(root, file).split(path.sep).join('/'));
  for (const file of ['api/notes.js', 'api/fetch-url.js', 'cloud.js', 'supabase-config.js', 'sw.js',
    'lib/notes-security.js', 'lib/sync-journal.js', 'scripts/check-syntax.js', 'test/syntax-check.test.js']) {
    assert.ok(files.includes(file), file);
  }
});
