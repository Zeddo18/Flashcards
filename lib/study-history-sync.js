/* Per-account, per-device study-history replication. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FCStudyHistorySync = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  const DEVICE_KEY = "fc_study_device_id";
  const MAX_SOURCES = 32;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function create(options) {
    const storage = options.storage;
    const cloud = options.cloud;
    const analytics = options.analytics;
    const isCurrent = options.isCurrent || (() => true);
    const lock = options.lock || null;
    const uuid = options.uuid;
    if (!storage || !cloud || !analytics || typeof uuid !== "function") {
      throw new TypeError("Study-history storage, cloud, analytics and UUID providers are required.");
    }

    function assertCurrent(account) {
      if (!isCurrent(account)) throw new Error("Account changed. Study history was not synchronized.");
    }
    function lockName(account) { return "fc-study-history-" + account.userId; }
    function withLock(account, work) {
      if (!lock) return Promise.resolve().then(work);
      return Promise.resolve(lock(lockName(account), work));
    }
    function deviceId() {
      let value = storage.getItem(DEVICE_KEY);
      if (!UUID_RE.test(value || "")) {
        value = uuid();
        if (typeof value !== "string" || !UUID_RE.test(value)) {
          throw new Error("A valid device ID could not be created.");
        }
        storage.setItem(DEVICE_KEY, value);
      }
      return value;
    }
    function legacyKey(account) {
      return account.userId ? "fc_study_history::" + account.userId : "fc_study_history";
    }
    function sourcesKey(account) {
      return "fc_study_history_sources::" + account.userId;
    }
    function readLegacy(account) {
      const raw = storage.getItem(legacyKey(account));
      if (raw === null) return analytics.createHistory();
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { throw new Error("Existing study history is unreadable. Export a backup before changing it."); }
      return analytics.validateHistory(analytics.normalizeHistory(parsed));
    }
    function validateSources(input) {
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          input.version !== 1 || !input.sources || typeof input.sources !== "object" ||
          Array.isArray(input.sources)) {
        throw new Error("Saved study-history sync data is invalid. It was left unchanged.");
      }
      const entries = Object.entries(input.sources);
      if (entries.length > MAX_SOURCES) throw new Error("Study history has too many device sources to sync safely.");
      const sources = {};
      for (const [id, history] of entries) {
        if (!UUID_RE.test(id)) throw new Error("Study history contains an invalid source ID.");
        sources[id] = analytics.validateHistory(history);
      }
      return sources;
    }
    function saveSources(account, sources) {
      const entries = Object.entries(sources).sort(([a], [b]) => a.localeCompare(b));
      if (entries.length > MAX_SOURCES) throw new Error("Study history has too many device sources to sync safely.");
      const payload = { version: 1, sources: Object.fromEntries(entries) };
      if (JSON.stringify(payload).length > 5000000) throw new Error("Study history exceeds the safe sync size.");
      storage.setItem(sourcesKey(account), JSON.stringify(payload));
      return payload;
    }
    function readSources(account, id) {
      const raw = storage.getItem(sourcesKey(account));
      let sources;
      if (raw === null) {
        sources = { [id]: readLegacy(account) };
        saveSources(account, sources);
      } else {
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { throw new Error("Saved study-history sync data is unreadable. It was left unchanged."); }
        sources = validateSources(parsed);
        if (!Object.prototype.hasOwnProperty.call(sources, id)) {
          sources[id] = analytics.createHistory();
          saveSources(account, sources);
        }
      }
      return sources;
    }
    function mergeSourceMaps(target, incoming) {
      for (const [id, history] of Object.entries(incoming)) {
        target[id] = Object.prototype.hasOwnProperty.call(target, id)
          ? analytics.mergeHistory(target[id], history)
          : analytics.validateHistory(history);
      }
      if (Object.keys(target).length > MAX_SOURCES) {
        throw new Error("Study history has too many device sources to sync safely.");
      }
      return target;
    }
    function decodeRow(row) {
      if (!row || typeof row.device_id !== "string" || !UUID_RE.test(row.device_id)) {
        throw new Error("Cloud study history contains an invalid device ID.");
      }
      const value = row.history;
      if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
        throw new Error("Cloud study history contains an unsupported record.");
      }
      if (Array.isArray(value.sources)) {
        const decoded = {};
        for (const source of value.sources) {
          if (!source || typeof source.sourceId !== "string" || !UUID_RE.test(source.sourceId) || !source.history ||
              Object.prototype.hasOwnProperty.call(decoded, source.sourceId)) {
            throw new Error("Cloud study history contains an invalid or duplicate device source.");
          }
          decoded[source.sourceId] = source.history;
        }
        return validateSources({ version: 1, sources: decoded });
      }
      // Compatibility with a version-1 history row written before source envelopes.
      return { [row.device_id]: analytics.validateHistory(value) };
    }
    function encodeEnvelope(sources) {
      const entries = Object.entries(sources).sort(([a], [b]) => a.localeCompare(b));
      if (entries.length > MAX_SOURCES) throw new Error("Study history has too many device sources to sync safely.");
      const envelope = {
        version: 1,
        sources: entries.map(([sourceId, history]) => ({
          sourceId, history: analytics.validateHistory(history)
        }))
      };
      if (JSON.stringify(envelope).length > 5000000) throw new Error("Study history exceeds the safe sync size.");
      return envelope;
    }

    function addCount(a, b) {
      const value = a + b;
      if (!Number.isSafeInteger(value)) throw new Error("Study-history totals exceed the safe numeric range.");
      return value;
    }
    function addBucket(map, item) {
      const old = map.get(item.deckId);
      if (!old) {
        map.set(item.deckId, {
          deckId: item.deckId, deckName: item.deckName,
          reviews: item.reviews, ratings: item.ratings.slice(),
          sessions: item.sessions, sessionCards: item.sessionCards,
          completedCards: item.completedCards, lastStudied: item.lastStudied
        });
        return;
      }
      old.reviews = addCount(old.reviews, item.reviews);
      old.ratings = old.ratings.map((v, i) => addCount(v, item.ratings[i]));
      old.sessions = addCount(old.sessions, item.sessions);
      old.sessionCards = addCount(old.sessionCards, item.sessionCards);
      old.completedCards = addCount(old.completedCards, item.completedCards);
      if (item.lastStudied > old.lastStudied ||
          (item.lastStudied === old.lastStudied && item.deckName.localeCompare(old.deckName) > 0)) {
        old.deckName = item.deckName;
      }
      if (item.lastStudied > old.lastStudied) old.lastStudied = item.lastStudied;
    }
    function aggregateSources(sources) {
      const histories = Array.isArray(sources) ? sources : Object.values(sources || {});
      const result = analytics.createHistory();
      const decks = new Map(), days = new Map(), activeDates = new Set();
      let olderActiveDays = 0;
      for (const input of histories) {
        const history = analytics.validateHistory(input);
        result.totals.reviews = addCount(result.totals.reviews, history.totals.reviews);
        result.totals.ratings = result.totals.ratings.map((v, i) => addCount(v, history.totals.ratings[i]));
        result.totals.sessions = addCount(result.totals.sessions, history.totals.sessions);
        result.totals.sessionCards = addCount(result.totals.sessionCards, history.totals.sessionCards);
        result.totals.completedCards = addCount(result.totals.completedCards, history.totals.completedCards);
        const retainedActive = new Set(history.days.filter(day => day.reviews > 0).map(day => day.date));
        retainedActive.forEach(date => activeDates.add(date));
        olderActiveDays = addCount(olderActiveDays, Math.max(0, history.totals.activeDays - retainedActive.size));
        history.decks.forEach(deck => addBucket(decks, deck));
        for (const day of history.days) {
          let target = days.get(day.date);
          if (!target) {
            target = { date: day.date, reviews: 0, ratings: [0, 0, 0, 0],
              sessions: 0, sessionCards: 0, completedCards: 0, decks: new Map() };
            days.set(day.date, target);
          }
          target.reviews = addCount(target.reviews, day.reviews);
          target.ratings = target.ratings.map((v, i) => addCount(v, day.ratings[i]));
          target.sessions = addCount(target.sessions, day.sessions);
          target.sessionCards = addCount(target.sessionCards, day.sessionCards);
          target.completedCards = addCount(target.completedCards, day.completedCards);
          day.decks.forEach(deck => addBucket(target.decks, deck));
        }
      }
      result.totals.activeDays = addCount(olderActiveDays, activeDates.size);
      result.decks = [...decks.values()].sort((a, b) => a.deckId.localeCompare(b.deckId));
      result.days = [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
        .slice(-analytics.RETENTION_DAYS)
        .map(day => ({ ...day, decks: [...day.decks.values()].sort((a, b) => a.deckId.localeCompare(b.deckId)) }));
      return analytics.validateHistory(result);
    }
    function snapshot(account, sources, id) {
      const deviceHistory = account.userId ? sources[id] : readLegacy(account);
      return {
        deviceId: account.userId ? id : null,
        deviceHistory: analytics.validateHistory(deviceHistory),
        sources: account.userId ? clone(sources) : {},
        history: account.userId ? aggregateSources(sources) : analytics.validateHistory(deviceHistory)
      };
    }
    function activate(account) {
      assertCurrent(account);
      if (!account.userId) {
        const history = readLegacy(account);
        return { deviceId: null, deviceHistory: history, sources: {}, history };
      }
      const id = deviceId();
      const sources = readSources(account, id);
      return snapshot(account, sources, id);
    }
    function record(account, kind, event) {
      return withLock(account, () => {
        assertCurrent(account);
        if (!account.userId) {
          const current = readLegacy(account);
          const next = kind === "review"
            ? analytics.recordReview(current, event)
            : analytics.recordSession(current, event);
          storage.setItem(legacyKey(account), JSON.stringify(next));
          return { deviceId: null, deviceHistory: next, sources: {}, history: next, saved: true };
        }
        const id = deviceId();
        const sources = readSources(account, id);
        sources[id] = kind === "review"
          ? analytics.recordReview(sources[id], event)
          : analytics.recordSession(sources[id], event);
        saveSources(account, sources);
        assertCurrent(account);
        return { ...snapshot(account, sources, id), saved: true };
      });
    }
    function recordReview(account, event) { return record(account, "review", event); }
    function recordSession(account, event) { return record(account, "session", event); }
    async function sync(account) {
      assertCurrent(account);
      if (!account.userId) return activate(account);
      if (!lock) return { ...activate(account), synced: false, pending: true };
      return withLock(account, async () => {
        assertCurrent(account);
        if (typeof cloud.listMyStudyHistoryDevices !== "function" ||
            typeof cloud.upsertMyStudyHistoryDevice !== "function") {
          throw new Error("Cloud study-history support is not available.");
        }
        const id = deviceId();
        const sources = readSources(account, id);
        const rows = await cloud.listMyStudyHistoryDevices(account.userId);
        assertCurrent(account);
        if (!Array.isArray(rows)) throw new Error("Cloud study history returned an invalid response.");
        for (const row of rows) {
          if (row.user_id && row.user_id !== account.userId) {
            throw new Error("Cloud study history returned another account's data.");
          }
          mergeSourceMaps(sources, decodeRow(row));
        }
        if (!Object.prototype.hasOwnProperty.call(sources, id)) sources[id] = analytics.createHistory();
        saveSources(account, sources); // Persist merged progress before attempting the upload.
        const envelope = encodeEnvelope(sources);
        const acknowledgement = await cloud.upsertMyStudyHistoryDevice(id, envelope, account.userId);
        assertCurrent(account);
        if (!acknowledgement || acknowledgement.device_id !== id) {
          throw new Error("Cloud study-history upload was not acknowledged for this device.");
        }
        if (acknowledgement.history) mergeSourceMaps(sources, decodeRow(acknowledgement));
        saveSources(account, sources);
        return { ...snapshot(account, sources, id), synced: true, pending: false };
      });
    }
    function importBackup(account, history, incomingSources) {
      assertCurrent(account);
      if (!account.userId) {
        if (!history) return activate(account);
        const merged = analytics.mergeHistory(readLegacy(account), history);
        storage.setItem(legacyKey(account), JSON.stringify(merged));
        return { deviceId: null, deviceHistory: merged, sources: {}, history: merged, saved: true };
      }
      const id = deviceId();
      const sources = readSources(account, id);
      if (Array.isArray(incomingSources) && incomingSources.length) {
        const incoming = {};
        for (const source of incomingSources) {
          if (!source || typeof source.sourceId !== "string" || !UUID_RE.test(source.sourceId) || !source.history) {
            throw new Error("Backup contains an invalid study-history source.");
          }
          incoming[source.sourceId] = analytics.validateHistory(source.history);
        }
        mergeSourceMaps(sources, incoming);
      } else if (history) {
        sources[id] = analytics.mergeHistory(sources[id], analytics.validateHistory(history));
      }
      saveSources(account, sources);
      return { ...snapshot(account, sources, id), saved: true };
    }
    function exportSources(account) {
      assertCurrent(account);
      if (!account.userId) return [];
      const id = deviceId();
      const sources = readSources(account, id);
      return Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))
        .map(([sourceId, history]) => ({ sourceId, history: clone(history) }));
    }

    return { activate, recordReview, recordSession, sync, importBackup, exportSources, deviceId,
      aggregateSources, validateSources, encodeEnvelope };
  }

  return { create };
});
