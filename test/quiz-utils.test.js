'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeQuizResponse,
  gradeEnumeration
} = require('../lib/quiz-utils');

test('multiple-choice responses contain the correct answer once and distinct options', () => {
  const result = normalizeQuizResponse('mc', { questions: [{
    prompt: 'What is the main gas plants absorb?',
    answer: 'Carbon dioxide',
    options: ['Water', 'carbon dioxide', 'WATER', 'Oxygen', 'Nitrogen', 'Argon']
  }] }, 1);
  assert.deepEqual(result.questions[0].options, ['Water', 'Carbon dioxide', 'Oxygen', 'Nitrogen']);
  assert.equal(result.questions[0].options.filter(x => x.toLowerCase() === 'carbon dioxide').length, 1);
});

test('multiple-choice response missing its correct option adds it without losing all distractors', () => {
  const result = normalizeQuizResponse('mc', { questions: [{
    prompt: 'Which process makes glucose?',
    answer: 'Photosynthesis',
    options: ['Respiration', 'Fermentation', 'Transpiration']
  }] }, 1);
  assert.deepEqual(result.questions[0].options, ['Photosynthesis', 'Respiration', 'Fermentation', 'Transpiration']);
});

test('rejects multiple-choice questions with no distinct distractor', () => {
  assert.equal(normalizeQuizResponse('mc', { questions: [{
    prompt: 'Question?', answer: 'Answer', options: [' answer ', 'ANSWER']
  }] }, 1), null);
});

test('rejects multiple-choice questions with no options', () => {
  assert.equal(normalizeQuizResponse('mc', { questions: [{
    prompt: 'Question?', answer: 'Answer'
  }] }, 1), null);
});

test('matching responses discard duplicate terms and definitions case-insensitively', () => {
  const result = normalizeQuizResponse('match', { pairs: [
    { term: 'Voltage', definition: 'Potential difference' },
    { term: 'voltage', definition: 'Electric pressure' },
    { term: 'Current', definition: 'Flow of charge' },
    { term: 'Resistance', definition: 'flow of charge' },
    { term: 'Power', definition: 'Rate of energy transfer' }
  ] }, 4);
  assert.deepEqual(result.pairs.map(pair => pair.term), ['Voltage', 'Current', 'Power']);
});

test('rejects matching response with fewer than two unambiguous pairs', () => {
  assert.equal(normalizeQuizResponse('match', { pairs: [
    { term: 'Voltage', definition: 'Potential difference' },
    { term: 'voltage', definition: 'Electric pressure' }
  ] }, 4), null);
});

test('enumeration output removes duplicate expected items', () => {
  const result = normalizeQuizResponse('enum', { questions: [{
    prompt: 'Name the states.',
    items: ['Solid', 'Liquid', 'solid', 'Gas']
  }] }, 1);
  assert.deepEqual(result.questions[0].items, ['Solid', 'Liquid', 'Gas']);
  assert.equal(result.questions[0].correct, 'Solid, Liquid, Gas');
});

test('enumeration grading accepts exact answers in any order', () => {
  const result = gradeEnumeration(['Oxygen', 'Carbon dioxide', 'Water'], ' water; OXYGEN, Carbon dioxide ');
  assert.equal(result.correct, true);
  assert.equal(result.matched, 3);
  assert.deepEqual(result.extra, []);
});

test('enumeration grading ignores trailing punctuation while keeping exact item matching', () => {
  const result = gradeEnumeration(['Solar energy', 'Water'], 'solar energy., WATER!');
  assert.equal(result.correct, true);
  assert.equal(result.matched, 2);
});

test('enumeration grading rejects partial substring answers', () => {
  const result = gradeEnumeration(['Solar energy'], 'solar');
  assert.equal(result.correct, false);
  assert.equal(result.matched, 0);
  assert.equal(result.results[0].matched, false);
});

test('enumeration grading rejects duplicate and extra answers', () => {
  const duplicate = gradeEnumeration(['Oxygen', 'Water'], 'Oxygen, Water, Water');
  assert.equal(duplicate.correct, false);
  assert.deepEqual(duplicate.extra, ['Water']);

  const extra = gradeEnumeration(['Oxygen', 'Water'], 'Oxygen, Water, Nitrogen');
  assert.equal(extra.correct, false);
  assert.deepEqual(extra.extra, ['Nitrogen']);
});

test('enumeration grading does not count one submitted item twice', () => {
  const result = gradeEnumeration(['Alpha', 'Beta'], 'Alpha, Alpha');
  assert.equal(result.correct, false);
  assert.equal(result.matched, 1);
  assert.equal(result.results[1].matched, false);
});

test('malformed questions are skipped and response count is capped', () => {
  const result = normalizeQuizResponse('typing', { questions: [
    null,
    { prompt: 'Q1', answer: 'A1' },
    { prompt: 'Q2', answer: 'A2' },
    { prompt: 'Q3', answer: 'A3' }
  ] }, 2);
  assert.equal(result.questions.length, 2);
});

test('quiz helper is loaded by the app and included in the offline shell', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(html, /<script src="\/lib\/quiz-utils\.js"><\/script>/);
  assert.match(sw, /"flushcard-v13"/);
  assert.match(sw, /"\/lib\/quiz-utils\.js"/);
});
