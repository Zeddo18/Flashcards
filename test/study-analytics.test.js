'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Analytics = require('../lib/study-analytics');

const localTime = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).getTime();
const event = (deckId, rating, timestamp, deckName = deckId) => ({ deckId, deckName, rating, timestamp });

test('creates an empty versioned history without inventing past study activity', () => {
  const history = Analytics.createHistory();
  assert.equal(history.version, 1);
  assert.equal(history.totals.reviews, 0);
  assert.equal(history.totals.activeDays, 0);
  assert.deepEqual(history.totals.ratings, [0, 0, 0, 0]);
  assert.deepEqual(history.decks, []);
  assert.deepEqual(history.days, []);
  assert.equal(Analytics.getSummary(history).recallRate, null);
});

test('records rating attempts and treats Again as a review but not successful recall', () => {
  let history = Analytics.createHistory();
  history = Analytics.recordReview(history, event('deck-1', 0, localTime(2026, 11, 25), 'Electrical'));
  history = Analytics.recordReview(history, event('deck-1', 2, localTime(2026, 11, 25, 13), 'Electrical'));
  history = Analytics.recordReview(history, event('deck-1', 3, localTime(2026, 11, 25, 14), 'Electrical'));
  const summary = Analytics.getSummary(history, localTime(2026, 11, 25));
  assert.equal(summary.reviews, 3);
  assert.deepEqual(summary.ratings, [1, 0, 1, 1]);
  assert.equal(summary.recallRate, 67);
  assert.equal(summary.activeDays, 1);
  assert.equal(summary.decks[0].deckName, 'Electrical');
  assert.equal(summary.decks[0].reviews, 3);
  assert.equal(summary.decks[0].recallRate, 67);
});

test('multiple Again ratings remain separate review attempts', () => {
  let history = Analytics.createHistory();
  history = Analytics.recordReview(history, event('d', 0, localTime(2026, 11, 25)));
  history = Analytics.recordReview(history, event('d', 0, localTime(2026, 11, 25, 13)));
  const summary = Analytics.getSummary(history, localTime(2026, 11, 25));
  assert.equal(summary.reviews, 2);
  assert.equal(summary.recallRate, 0);
  assert.equal(summary.decks[0].ratings[0], 2);
});

test('aggregates daily reviews and rating counts by local calendar date', () => {
  let history = Analytics.createHistory();
  history = Analytics.recordReview(history, event('d', 2, localTime(2026, 11, 25, 23)));
  history = Analytics.recordReview(history, event('d', 3, localTime(2026, 11, 26, 1)));
  assert.equal(history.days.length, 2);
  assert.deepEqual(history.days.map(day => day.reviews), [1, 1]);
  assert.deepEqual(history.days.map(day => day.date), ['2026-11-25', '2026-11-26']);
  assert.equal(Analytics.getSummary(history, localTime(2026, 11, 26)).activeDays, 2);
});

test('records completed sessions separately from individual review attempts', () => {
  let history = Analytics.createHistory();
  history = Analytics.recordReview(history, event('d', 0, localTime(2026, 11, 25)));
  history = Analytics.recordReview(history, event('d', 2, localTime(2026, 11, 25, 13)));
  history = Analytics.recordSession(history, {
    deckId: 'd', deckName: 'Biology', total: 4, completed: 4, timestamp: localTime(2026, 11, 25, 14)
  });
  const summary = Analytics.getSummary(history, localTime(2026, 11, 25));
  assert.equal(summary.reviews, 2);
  assert.equal(summary.sessions, 1);
  assert.equal(summary.sessionCards, 4);
  assert.equal(summary.completedCards, 4);
  assert.equal(summary.completionRate, 100);
  assert.equal(summary.decks[0].sessions, 1);
});

test('keeps independent lifetime statistics for each deck', () => {
  let history = Analytics.createHistory();
  history = Analytics.recordReview(history, event('a', 2, localTime(2026, 11, 25), 'Deck A'));
  history = Analytics.recordReview(history, event('b', 0, localTime(2026, 11, 25), 'Deck B'));
  history = Analytics.recordReview(history, event('a', 3, localTime(2026, 11, 26), 'Deck A renamed'));
  const summary = Analytics.getSummary(history, localTime(2026, 11, 26));
  assert.equal(summary.decks.length, 2);
  assert.equal(summary.decks[0].deckId, 'a');
  assert.equal(summary.decks[0].deckName, 'Deck A renamed');
  assert.equal(summary.decks[0].reviews, 2);
  assert.equal(summary.decks[1].deckId, 'b');
  assert.equal(summary.decks[1].recallRate, 0);
});

test('calculates current and longest streaks across consecutive study days', () => {
  let history = Analytics.createHistory();
  [24, 25, 26].forEach(day => {
    history = Analytics.recordReview(history, event('d', 2, localTime(2026, 11, day)));
  });
  const summary = Analytics.getSummary(history, localTime(2026, 11, 26));
  assert.equal(summary.currentStreak, 3);
  assert.equal(summary.longestStreak, 3);
});

test('yesterday can anchor the current streak when today has no reviews yet', () => {
  let history = Analytics.createHistory();
  [24, 25].forEach(day => {
    history = Analytics.recordReview(history, event('d', 2, localTime(2026, 11, day)));
  });
  const summary = Analytics.getSummary(history, localTime(2026, 11, 26));
  assert.equal(summary.currentStreak, 2);
});

test('a missed calendar day breaks the current streak but preserves the longest streak', () => {
  let history = Analytics.createHistory();
  [20, 21, 23].forEach(day => {
    history = Analytics.recordReview(history, event('d', 2, localTime(2026, 11, day)));
  });
  const summary = Analytics.getSummary(history, localTime(2026, 11, 23));
  assert.equal(summary.currentStreak, 1);
  assert.equal(summary.longestStreak, 2);
});

test('weekly activity always contains seven local dates including zero-activity days', () => {
  let history = Analytics.createHistory();
  history = Analytics.recordReview(history, event('d', 2, localTime(2026, 11, 23)));
  history = Analytics.recordReview(history, event('d', 0, localTime(2026, 11, 26)));
  const summary = Analytics.getSummary(history, localTime(2026, 11, 26));
  assert.equal(summary.weekly.length, 7);
  assert.deepEqual(summary.weekly.map(day => day.date), [
    '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23',
    '2026-11-24', '2026-11-25', '2026-11-26'
  ]);
  assert.deepEqual(summary.weekly.map(day => day.reviews), [0, 0, 0, 1, 0, 0, 1]);
});

test('sorts deck analytics by review activity and retains history after deck deletion', () => {
  let history = Analytics.createHistory();
  history = Analytics.recordReview(history, event('a', 2, localTime(2026, 11, 25), 'Old deck'));
  history = Analytics.recordReview(history, event('b', 2, localTime(2026, 11, 25), 'Current deck'));
  history = Analytics.recordReview(history, event('b', 2, localTime(2026, 11, 26), 'Current deck'));
  const summary = Analytics.getSummary(history, localTime(2026, 11, 26));
  assert.equal(summary.decks[0].deckId, 'b');
  assert.equal(summary.decks.length, 2);
});

test('normalizes malformed saved history without trusting invalid counts or dates', () => {
  const normalized = Analytics.normalizeHistory({
    version: 99,
    totals: { reviews: -2, ratings: [1, Infinity, 'bad', 3], sessions: 2.5, activeDays: 4 },
    decks: [{ deckId: 'd', deckName: 'Deck', reviews: Number.MAX_VALUE, ratings: [0, 0, 0, 0] }],
    days: [{ date: '2026-02-31', reviews: 9 }, { date: '2026-11-25', reviews: 2 }]
  });
  assert.equal(normalized.version, 1);
  assert.equal(normalized.totals.reviews, 0);
  assert.deepEqual(normalized.totals.ratings, [1, 0, 0, 3]);
  assert.equal(normalized.totals.sessions, 0);
  assert.equal(normalized.days.length, 1);
  assert.equal(normalized.days[0].date, '2026-11-25');
});

test('rejects invalid review and session events', () => {
  assert.throws(() => Analytics.recordReview(Analytics.createHistory(), { deckId: '', rating: 2 }), TypeError);
  assert.throws(() => Analytics.recordReview(Analytics.createHistory(), event('d', 4, Date.now())), TypeError);
  assert.throws(() => Analytics.recordReview(Analytics.createHistory(), event('d', 2, NaN)), TypeError);
  assert.throws(() => Analytics.recordSession(Analytics.createHistory(), {
    deckId: 'd', total: 2, completed: 3
  }), TypeError);
});

test('caps detailed daily history while retaining lifetime aggregates', () => {
  let history = Analytics.createHistory();
  const start = localTime(2024, 1, 1);
  for (let i = 0; i < Analytics.RETENTION_DAYS + 1; i++) {
    history = Analytics.recordReview(history, event('d', 2, start + i * Analytics.DAY_MS));
  }
  assert.equal(history.days.length, Analytics.RETENTION_DAYS);
  assert.equal(history.totals.reviews, Analytics.RETENTION_DAYS + 1);
  assert.equal(history.totals.activeDays, Analytics.RETENTION_DAYS + 1);
});

test('recording returns a new history object and leaves the saved input unchanged', () => {
  const original = Analytics.createHistory();
  const next = Analytics.recordReview(original, event('d', 2, localTime(2026, 11, 25)));
  assert.equal(original.totals.reviews, 0);
  assert.equal(next.totals.reviews, 1);
  assert.notEqual(original, next);
});

test('frontend reloads account-scoped analytics and precaches the helper offline', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(html, /<script src="\/lib\/study-analytics\.js"><\/script>/);
  assert.match(html, /fc_study_history/);
  assert.match(html, /studyHistory = loadStudyHistory\(\)/);
  assert.match(html, /window\.FCStudyAnalytics\.recordReview/);
  assert.match(html, /Cards completed in completed sessions/);
  assert.match(html, /Longest streak \(2-year history\)/);
  assert.match(html, /Detailed daily history is retained for 2 years/);
  assert.match(sw, /"flushcard-v13"/);
  assert.match(sw, /"\/lib\/study-analytics\.js"/);
});
