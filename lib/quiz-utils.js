/* Shared quiz response validation and strict enumeration grading. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FCQuizUtils = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";

  function cleanText(value, max = 1000) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function key(value) {
    return String(value).normalize("NFKC").toLowerCase().trim().replace(/[.,;:!?]+$/g, "").replace(/\s+/g, " ");
  }

  function uniqueStrings(values, limit) {
    if (!Array.isArray(values)) return [];
    const seen = new Set(), result = [];
    for (const value of values) {
      const text = cleanText(value);
      const normalized = key(text);
      if (!text || !normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(text);
      if (result.length >= limit) break;
    }
    return result;
  }

  function normalizeQuizResponse(type, parsed, limit) {
    if (Array.isArray(parsed)) parsed = type === "match" ? { pairs: parsed } : { questions: parsed };
    if (!parsed || typeof parsed !== "object" || !Number.isInteger(limit) || limit < 1) return null;

    if (type === "match") {
      const terms = new Set(), definitions = new Set(), pairs = [];
      for (const pair of Array.isArray(parsed.pairs) ? parsed.pairs : []) {
        if (!pair || typeof pair !== "object") continue;
        const term = cleanText(pair.term), definition = cleanText(pair.definition);
        const termKey = key(term), definitionKey = key(definition);
        if (!term || !definition || !termKey || !definitionKey ||
            terms.has(termKey) || definitions.has(definitionKey)) continue;
        terms.add(termKey);
        definitions.add(definitionKey);
        pairs.push({ term, definition, tip: cleanText(pair.tip || pair.hint, 360) });
        if (pairs.length >= limit) break;
      }
      return pairs.length >= 2 ? { pairs } : null;
    }

    const questions = [];
    for (const question of Array.isArray(parsed.questions) ? parsed.questions : []) {
      if (!question || typeof question !== "object" || Array.isArray(question)) continue;
      const prompt = cleanText(question.prompt || question.question || question.clue);
      const rawItems = uniqueStrings(question.items, 12);
      const answer = cleanText(question.answer || question.correctAnswer || question.correct) ||
        (type === "enum" ? rawItems.join(", ") : "");
      if (!prompt || !answer) continue;

      let correct = answer;
      if (type === "tf") {
        if (/^true$/i.test(answer)) correct = "True";
        else if (/^false$/i.test(answer)) correct = "False";
        else continue;
      }

      const item = {
        prompt,
        correct,
        explanation: cleanText(question.explanation || question.reason),
        tip: cleanText(question.tip || question.hint, 360)
      };

      if (type === "mc") {
        let options = uniqueStrings(question.options, 4);
        const answerKey = key(answer);
        const answerIndex = options.findIndex(option => key(option) === answerKey);
        if (answerIndex === -1) {
          options = [answer, ...options].slice(0, 4);
        } else {
          options[answerIndex] = answer;
        }
        if (options.length < 2) continue;
        item.options = options;
      } else if (type === "enum") {
        if (rawItems.length < 2) continue;
        item.items = rawItems;
        item.correct = rawItems.join(", ");
      } else if (Array.isArray(question.acceptedAnswers)) {
        item.acceptedAnswers = uniqueStrings(question.acceptedAnswers, 8)
          .filter(value => key(value) !== key(correct));
      }

      questions.push(item);
      if (questions.length >= limit) break;
    }
    return questions.length ? { questions } : null;
  }

  function splitItems(value) {
    return String(value)
      .split(/[\n,;•·]+/g)
      .map(item => item.replace(/^[-–—\s]+/, "").trim())
      .filter(item => item.length > 1);
  }

  function gradeEnumeration(expectedItems, answerText) {
    const expected = uniqueStrings(expectedItems, 12);
    const received = splitItems(answerText);
    const used = new Set();
    const results = expected.map(item => {
      const itemKey = key(item);
      const index = received.findIndex((value, i) => !used.has(i) && key(value) === itemKey);
      if (index !== -1) used.add(index);
      return { item, matched: index !== -1 };
    });
    const matched = results.filter(result => result.matched).length;
    const extra = received.filter((value, index) => !used.has(index));
    return {
      matched,
      total: expected.length,
      extra,
      results,
      correct: expected.length > 0 && matched === expected.length && received.length === expected.length
    };
  }

  return { cleanText, uniqueStrings, normalizeQuizResponse, splitItems, gradeEnumeration };
});
