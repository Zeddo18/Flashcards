/* Flashcard spaced-repetition scheduling and session metrics. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FCSRS = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  const DAY = 86400000, MINUTE = 60000, AGAIN_DELAY = 10 * MINUTE;
  const MIN_EASE = 1.3, MAX_EASE = 3, MAX_INTERVAL = 36500;
  function finiteNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }
  function safeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  function normalizeSrs(srs) {
    const source = srs && typeof srs === "object" && !Array.isArray(srs) ? srs : {};
    return {
      interval: Math.min(MAX_INTERVAL, Math.max(0, finiteNumber(source.interval, 0))),
      ease: Math.min(MAX_EASE, Math.max(MIN_EASE, finiteNumber(source.ease, 2.5))),
      reps: safeCount(source.reps),
      lapses: safeCount(source.lapses)
    };
  }
  function nextSrs(srs, rating, now = Date.now()) {
    if (!Number.isInteger(rating) || rating < 0 || rating > 3) {
      throw new RangeError("Rating must be an integer from 0 (Again) to 3 (Easy).");
    }
    if (typeof now !== "number" || !Number.isFinite(now)) {
      throw new TypeError("The review timestamp must be a finite number.");
    }
    let { interval, ease, reps, lapses } = normalizeSrs(srs);
    let delay;
    if (rating === 0) {
      lapses++;
      ease = Math.max(MIN_EASE, ease - 0.25);
      interval = 0;
      reps = 0;
      delay = AGAIN_DELAY;
    } else if (rating === 1) {
      interval = interval < 1 ? 0.5 : interval * 1.2;
      ease = Math.max(MIN_EASE, ease - 0.15);
      reps++;
      delay = interval * DAY;
    } else if (rating === 2) {
      interval = reps === 0 ? 1 : interval < 1 ? 2 : interval * ease;
      reps++;
      delay = interval * DAY;
    } else {
      interval = reps === 0 ? 3 : interval < 1 ? 3 : interval * ease * 1.3;
      ease = Math.min(MAX_EASE, ease + 0.15);
      reps++;
      delay = interval * DAY;
    }
    interval = Math.min(MAX_INTERVAL, Math.max(0, interval));
    return { interval, ease, reps, lapses, due: now + delay, last: now };
  }
  function formatDelay(milliseconds) {
    const delay = Math.max(MINUTE, finiteNumber(milliseconds, MINUTE));
    if (delay < 60 * MINUTE) return Math.max(1, Math.round(delay / MINUTE)) + "m";
    if (delay < DAY) return Math.max(1, Math.round(delay / (60 * MINUTE))) + "h";
    if (delay < 30 * DAY) return Math.max(1, Math.round(delay / DAY)) + "d";
    if (delay < 365 * DAY) return Math.max(1, Math.round(delay / (30 * DAY))) + "mo";
    return (delay / (365 * DAY)).toFixed(1) + "y";
  }
  function previewInterval(srs, rating) {
    const now = 0;
    return formatDelay(nextSrs(srs, rating, now).due - now);
  }
  function isDue(card, now = Date.now()) {
    if (!card || !card.srs || typeof card.srs !== "object") return true;
    const due = card.srs.due;
    return typeof due !== "number" || !Number.isFinite(due) || due <= now;
  }
  function isLearned(card) {
    return !!(card && card.srs && typeof card.srs.interval === "number" &&
      Number.isFinite(card.srs.interval) && card.srs.interval >= 21);
  }
  function dueCount(deck, now = Date.now()) {
    return deck && Array.isArray(deck.cards) ? deck.cards.filter(card => isDue(card, now)).length : 0;
  }
  function selectSessionCards(deck, filter = "all", now = Date.now()) {
    if (!deck || !Array.isArray(deck.cards)) return [];
    if (filter === "due") return deck.cards.filter(card => isDue(card, now));
    if (filter === "missed") {
      return deck.cards.filter(card => normalizeSrs(card && card.srs).lapses > 0);
    }
    return deck.cards.slice();
  }
  function createSession(total, now = Date.now()) {
    return {
      total: safeCount(total), done: 0, completed: 0,
      started: finiteNumber(now, Date.now()), counts: [0, 0, 0, 0]
    };
  }
  function recordRating(session, rating) {
    if (!session || !Array.isArray(session.counts) || session.counts.length !== 4 ||
        !Number.isInteger(rating) || rating < 0 || rating > 3) {
      throw new TypeError("A valid study session and rating are required.");
    }
    session.counts[rating]++;
    session.done++;
    if (rating !== 0) session.completed++;
    return session;
  }
  return {
    DAY, AGAIN_DELAY, normalizeSrs, nextSrs, previewInterval, isDue,
    isLearned, dueCount, selectSessionCards, createSession, recordRating
  };
});
