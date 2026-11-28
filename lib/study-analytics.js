/* Local, account-scoped study history and progress summaries. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FCStudyAnalytics = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  const DAY_MS = 86400000, RETENTION_DAYS = 730;
  function safeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  function ratingsArray(value) {
    return [0, 1, 2, 3].map(index => safeCount(Array.isArray(value) ? value[index] : 0));
  }
  function validDateKey(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }
  function dateKey(timestamp = Date.now()) {
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      throw new TypeError("A finite timestamp is required.");
    }
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) throw new RangeError("The timestamp is outside the supported date range.");
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")].join("-");
  }
  function createHistory() {
    return {
      version: 1,
      totals: { reviews: 0, ratings: [0, 0, 0, 0], sessions: 0,
        sessionCards: 0, completedCards: 0, activeDays: 0 },
      decks: [], days: []
    };
  }
  function normalizeBucket(source) {
    const item = source && typeof source === "object" ? source : {};
    return {
      deckId: typeof item.deckId === "string" ? item.deckId.slice(0, 128) : "",
      deckName: typeof item.deckName === "string" ? item.deckName.slice(0, 120) : "Untitled deck",
      reviews: safeCount(item.reviews), ratings: ratingsArray(item.ratings),
      sessions: safeCount(item.sessions), sessionCards: safeCount(item.sessionCards),
      completedCards: safeCount(item.completedCards),
      lastStudied: validDateKey(item.lastStudied) ? item.lastStudied : ""
    };
  }
  function normalizeDay(source) {
    const item = source && typeof source === "object" ? source : {};
    if (!validDateKey(item.date)) return null;
    return {
      date: item.date, reviews: safeCount(item.reviews), ratings: ratingsArray(item.ratings),
      sessions: safeCount(item.sessions), sessionCards: safeCount(item.sessionCards),
      completedCards: safeCount(item.completedCards),
      decks: Array.isArray(item.decks) ? item.decks.map(normalizeBucket).filter(d => d.deckId) : []
    };
  }
  function normalizeHistory(input) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const totals = source.totals && typeof source.totals === "object" ? source.totals : {};
    const history = {
      version: 1,
      totals: {
        reviews: safeCount(totals.reviews), ratings: ratingsArray(totals.ratings),
        sessions: safeCount(totals.sessions), sessionCards: safeCount(totals.sessionCards),
        completedCards: safeCount(totals.completedCards), activeDays: safeCount(totals.activeDays)
      },
      decks: Array.isArray(source.decks) ? source.decks.map(normalizeBucket).filter(d => d.deckId) : [],
      days: Array.isArray(source.days) ? source.days.map(normalizeDay).filter(Boolean) : []
    };
    history.days.sort((a, b) => a.date.localeCompare(b.date));
    if (history.days.length > RETENTION_DAYS) history.days = history.days.slice(-RETENTION_DAYS);
    return history;
  }
  function ensureBucket(list, deckId, deckName) {
    let bucket = list.find(item => item.deckId === deckId);
    if (!bucket) {
      bucket = normalizeBucket({ deckId, deckName });
      list.push(bucket);
    } else if (deckName) bucket.deckName = String(deckName).slice(0, 120);
    return bucket;
  }
  function ensureDay(history, date) {
    let day = history.days.find(item => item.date === date);
    if (!day) {
      day = { date, reviews: 0, ratings: [0, 0, 0, 0],
        sessions: 0, sessionCards: 0, completedCards: 0, decks: [] };
      history.days.push(day);
      history.days.sort((a, b) => a.date.localeCompare(b.date));
      if (history.days.length > RETENTION_DAYS) history.days.shift();
    }
    return day;
  }
  function validateEvent(event) {
    if (!event || typeof event !== "object" ||
        typeof event.deckId !== "string" || !event.deckId.trim() ||
        !Number.isInteger(event.rating) || event.rating < 0 || event.rating > 3) {
      throw new TypeError("A deck ID and rating from 0 (Again) to 3 (Easy) are required.");
    }
    const timestamp = event.timestamp === undefined ? Date.now() : event.timestamp;
    const date = dateKey(timestamp);
    return {
      deckId: event.deckId.trim().slice(0, 128),
      deckName: typeof event.deckName === "string" && event.deckName.trim()
        ? event.deckName.trim().slice(0, 120) : "Untitled deck",
      rating: event.rating, timestamp, date
    };
  }
  function recordReview(input, event) {
    const state = normalizeHistory(input);
    const item = validateEvent(event);
    const day = ensureDay(state, item.date);
    const totalDeck = ensureBucket(state.decks, item.deckId, item.deckName);
    const dayDeck = ensureBucket(day.decks, item.deckId, item.deckName);
    if (day.reviews === 0) state.totals.activeDays++;
    state.totals.reviews++;
    state.totals.ratings[item.rating]++;
    totalDeck.reviews++;
    totalDeck.ratings[item.rating]++;
    totalDeck.lastStudied = item.date;
    day.reviews++;
    day.ratings[item.rating]++;
    dayDeck.reviews++;
    dayDeck.ratings[item.rating]++;
    dayDeck.lastStudied = item.date;
    return state;
  }
  function recordSession(input, event) {
    if (!event || typeof event !== "object" ||
        typeof event.deckId !== "string" || !event.deckId.trim() ||
        !Number.isSafeInteger(event.total) || event.total < 0 ||
        !Number.isSafeInteger(event.completed) || event.completed < 0 ||
        event.completed > event.total) {
      throw new TypeError("A deck ID and valid completed/total card counts are required.");
    }
    const timestamp = event.timestamp === undefined ? Date.now() : event.timestamp;
    const date = dateKey(timestamp);
    const deckId = event.deckId.trim().slice(0, 128);
    const deckName = typeof event.deckName === "string" && event.deckName.trim()
      ? event.deckName.trim().slice(0, 120) : "Untitled deck";
    const state = normalizeHistory(input);
    const day = ensureDay(state, date);
    const totalDeck = ensureBucket(state.decks, deckId, deckName);
    const dayDeck = ensureBucket(day.decks, deckId, deckName);
    state.totals.sessions++;
    state.totals.sessionCards += event.total;
    state.totals.completedCards += event.completed;
    totalDeck.sessions++;
    totalDeck.sessionCards += event.total;
    totalDeck.completedCards += event.completed;
    day.sessions++;
    day.sessionCards += event.total;
    day.completedCards += event.completed;
    dayDeck.sessions++;
    dayDeck.sessionCards += event.total;
    dayDeck.completedCards += event.completed;
    return state;
  }
  function shiftDate(value, amount) {
    const [year, month, day] = value.split("-").map(Number);
    return dateKey(new Date(year, month - 1, day + amount).getTime());
  }
  function ordinal(value) {
    const [year, month, day] = value.split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
  }
  function percentage(numerator, denominator) {
    return denominator ? Math.round((numerator / denominator) * 100) : null;
  }
  function summarizeBucket(bucket) {
    const reviews = bucket.reviews;
    return {
      deckId: bucket.deckId, deckName: bucket.deckName, reviews,
      ratings: bucket.ratings.slice(),
      recallRate: percentage(reviews - bucket.ratings[0], reviews),
      sessions: bucket.sessions, sessionCards: bucket.sessionCards,
      completedCards: bucket.completedCards,
      completionRate: percentage(bucket.completedCards, bucket.sessionCards),
      lastStudied: bucket.lastStudied
    };
  }
  function getSummary(input, now = Date.now()) {
    const state = normalizeHistory(input);
    const today = dateKey(now);
    const byDate = new Map(state.days.map(day => [day.date, day]));
    const activeDates = new Set(state.days.filter(day => day.reviews > 0).map(day => day.date));
    const anchor = activeDates.has(today) ? today : shiftDate(today, -1);
    let currentStreak = 0;
    if (activeDates.has(anchor)) {
      let cursor = anchor;
      while (activeDates.has(cursor)) {
        currentStreak++;
        cursor = shiftDate(cursor, -1);
      }
    }
    const activeSorted = Array.from(activeDates).sort();
    let longestStreak = 0, run = 0, previous = null;
    activeSorted.forEach(date => {
      run = previous !== null && ordinal(date) === ordinal(previous) + 1 ? run + 1 : 1;
      longestStreak = Math.max(longestStreak, run);
      previous = date;
    });
    const weekly = [];
    for (let offset = 6; offset >= 0; offset--) {
      const date = shiftDate(today, -offset);
      const day = byDate.get(date);
      const [year, month, dayOfMonth] = date.split("-").map(Number);
      const dateObject = new Date(year, month - 1, dayOfMonth);
      weekly.push({
        date,
        label: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dateObject.getDay()],
        reviews: day ? day.reviews : 0
      });
    }
    const totals = state.totals;
    return {
      reviews: totals.reviews, ratings: totals.ratings.slice(),
      recallRate: percentage(totals.reviews - totals.ratings[0], totals.reviews),
      activeDays: totals.activeDays, currentStreak, longestStreak,
      sessions: totals.sessions, sessionCards: totals.sessionCards,
      completedCards: totals.completedCards,
      completionRate: percentage(totals.completedCards, totals.sessionCards),
      weekly,
      decks: state.decks.map(summarizeBucket).sort((a, b) =>
        b.reviews - a.reviews || b.lastStudied.localeCompare(a.lastStudied) ||
        a.deckName.localeCompare(b.deckName))
    };
  }
  return {
    DAY_MS, RETENTION_DAYS, createHistory, normalizeHistory, dateKey,
    recordReview, recordSession, getSummary
  };
});
