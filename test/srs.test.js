'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SRS = require('../lib/srs');

const NOW = 1700000000000;
const DAY = 86400000;
const card = (id, srs) => ({ id, front: 'Question ' + id, back: 'Answer', ...(srs ? { srs } : {}) });

test('Again schedules a short retry, records a lapse, and resets successful repetitions', () => {
  const result = SRS.nextSrs({ interval: 12, ease: 2.5, reps: 4, lapses: 1 }, 0, NOW);
  assert.equal(result.interval, 0);
  assert.equal(result.reps, 0);
  assert.equal(result.lapses, 2);
  assert.equal(result.ease, 2.25);
  assert.equal(result.due, NOW + 10 * 60000);
  assert.equal(result.last, NOW);
  assert.equal(SRS.previewInterval({ interval: 12, ease: 2.5, reps: 4, lapses: 1 }, 0), '10m');
});

test('Hard schedules the half-day interval it previews instead of an unrelated ten-minute retry', () => {
  const result = SRS.nextSrs(undefined, 1, NOW);
  assert.equal(result.interval, 0.5);
  assert.equal(result.due, NOW + DAY / 2);
  assert.equal(SRS.previewInterval(undefined, 1), '12h');
});

test('Good and Easy use one-day and three-day initial intervals', () => {
  const good = SRS.nextSrs(undefined, 2, NOW);
  const easy = SRS.nextSrs(undefined, 3, NOW);
  assert.equal(good.interval, 1);
  assert.equal(good.due, NOW + DAY);
  assert.equal(easy.interval, 3);
  assert.equal(easy.due, NOW + 3 * DAY);
  assert.equal(easy.ease, 2.65);
  assert.equal(SRS.previewInterval(undefined, 2), '1d');
  assert.equal(SRS.previewInterval(undefined, 3), '3d');
});

test('Good after an Again lapse starts from the first successful interval', () => {
  const again = SRS.nextSrs({ interval: 18, ease: 2.5, reps: 6, lapses: 0 }, 0, NOW);
  const good = SRS.nextSrs(again, 2, NOW + 10 * 60000);
  assert.equal(good.reps, 1);
  assert.equal(good.interval, 1);
  assert.equal(good.due, NOW + 10 * 60000 + DAY);
  assert.equal(good.lapses, 1);
});

test('subsequent successful reviews grow from the saved interval and ease', () => {
  const good = SRS.nextSrs({ interval: 4, ease: 2.5, reps: 2, lapses: 0 }, 2, NOW);
  const easy = SRS.nextSrs({ interval: 4, ease: 2.5, reps: 2, lapses: 0 }, 3, NOW);
  assert.equal(good.interval, 10);
  assert.equal(easy.interval, 13);
  assert.equal(easy.ease, 2.65);
});

test('ease and interval stay inside supported bounds after repeated lapses', () => {
  let state = { interval: 0, ease: 1.31, reps: 0, lapses: 0 };
  for (let i = 0; i < 20; i++) state = SRS.nextSrs(state, 0, NOW + i);
  assert.equal(state.ease, 1.3);
  assert.equal(state.reps, 0);
  assert.equal(state.lapses, 20);
  const extreme = SRS.nextSrs({ interval: Number.MAX_VALUE, ease: 99, reps: 4, lapses: 0 }, 3, NOW);
  assert.ok(extreme.interval <= 36500);
  assert.equal(extreme.ease, 3);
  assert.equal(extreme.due, NOW + Math.round(extreme.interval * DAY));
  assert.ok(Number.isFinite(extreme.due));
});

test('malformed saved SRS fields normalize safely without mutating the original', () => {
  const original = { interval: -2, ease: Infinity, reps: -1, lapses: 2.5, due: NaN };
  const result = SRS.nextSrs(original, 2, NOW);
  assert.equal(result.interval, 1);
  assert.equal(result.ease, 2.5);
  assert.equal(result.reps, 1);
  assert.equal(result.lapses, 0);
  assert.equal(Number.isNaN(original.due), true);
});

test('invalid ratings and timestamps fail instead of silently scheduling Easy', () => {
  for (const rating of [-1, 4, 1.5, '3', null]) {
    assert.throws(() => SRS.nextSrs(undefined, rating, NOW), RangeError);
  }
  assert.throws(() => SRS.nextSrs(undefined, 2, NaN), TypeError);
});

test('cards without a valid due timestamp are considered due', () => {
  assert.equal(SRS.isDue(card('new'), NOW), true);
  assert.equal(SRS.isDue(card('missing', { interval: 3 }), NOW), true);
  assert.equal(SRS.isDue(card('invalid', { due: 'tomorrow' }), NOW), true);
  assert.equal(SRS.isDue(card('future', { due: NOW + 1 }), NOW), false);
  assert.equal(SRS.isDue(card('now', { due: NOW }), NOW), true);
});

test('due count and due selection use the same timestamp and never substitute all cards', () => {
  const due = card('due');
  const future = card('future', { interval: 3, due: NOW + DAY });
  const deck = { cards: [due, future] };
  assert.equal(SRS.dueCount(deck, NOW), 1);
  assert.deepEqual(SRS.selectSessionCards(deck, 'due', NOW), [due]);
  assert.deepEqual(SRS.selectSessionCards({ cards: [future] }, 'due', NOW), []);
});

test('missed selection includes cards with lapses and never falls back to all cards', () => {
  const newCard = card('new');
  const missed = card('missed', { interval: 0, ease: 2.25, reps: 0, lapses: 1 });
  const deck = { cards: [newCard, missed] };
  assert.deepEqual(SRS.selectSessionCards(deck, 'missed', NOW), [missed]);
  assert.deepEqual(SRS.selectSessionCards({ cards: [newCard] }, 'missed', NOW), []);
});

test('learned status requires a finite interval of at least 21 days', () => {
  assert.equal(SRS.isLearned(card('learned', { interval: 21 })), true);
  assert.equal(SRS.isLearned(card('learning', { interval: 20.99 })), false);
  assert.equal(SRS.isLearned(card('bad', { interval: Infinity })), false);
  assert.equal(SRS.isLearned(card('new')), false);
});

test('session metrics distinguish completed cards from retry attempts', () => {
  const session = SRS.createSession(2, NOW);
  SRS.recordRating(session, 0);
  assert.equal(session.done, 1);
  assert.equal(session.completed, 0);
  assert.equal(session.counts[0], 1);
  SRS.recordRating(session, 2);
  SRS.recordRating(session, 3);
  assert.equal(session.done, 3);
  assert.equal(session.completed, 2);
  assert.deepEqual(session.counts, [1, 0, 1, 1]);
  assert.equal(session.total, 2);
});

test('Again moves a card to the back and advances rather than immediately repeating the last card', () => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
  const cards = [a, b, c];
  const result = SRS.removeRatedCard(cards, 2, 0);
  assert.deepEqual(cards, [a, b, c]);
  assert.equal(result.card, c);
  assert.equal(result.index, 0);
  assert.equal(cards[result.index], a);
});

test('Again on the first card advances to the next card and a single-card retry remains available', () => {
  const a = { id: 'a' }, b = { id: 'b' };
  const cards = [a, b];
  const result = SRS.removeRatedCard(cards, 0, 0);
  assert.deepEqual(cards, [b, a]);
  assert.equal(result.index, 0);
  assert.equal(cards[result.index], b);

  const only = [a];
  const single = SRS.removeRatedCard(only, 0, 0);
  assert.deepEqual(only, [a]);
  assert.equal(single.index, 0);
});

test('non-Again ratings remove the card and wrap to the next available index', () => {
  const a = { id: 'a' }, b = { id: 'b' };
  const cards = [a, b];
  const result = SRS.removeRatedCard(cards, 1, 2);
  assert.deepEqual(cards, [a]);
  assert.equal(result.index, 0);
  assert.equal(result.remaining, 1);
});

test('virtual all-decks sessions can track ratings without writing SRS state', () => {
  const session = SRS.createSession(1, NOW);
  SRS.recordRating(session, 0);
  SRS.recordRating(session, 2);
  assert.equal(session.completed, 1);
  assert.equal(session.done, 2);
});

test('frontend and offline shell load the tested SRS module', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(html, /<script src="\/lib\/srs\.js"><\/script>/);
  assert.match(html, /window\.FCSRS\.selectSessionCards/);
  assert.match(html, /if \(!flipped\)/);
  assert.match(html, /s\.completed \+ ' \/ ' \+ s\.total/);
  assert.match(sw, /"flushcard-v14"/);
  assert.match(sw, /"\/lib\/srs\.js"/);
  assert.match(sw, /"\/lib\/study-history-sync\.js"/);
});
