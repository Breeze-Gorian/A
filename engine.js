(function (root) {
  "use strict";

  const data = typeof module === "object" && module.exports ? require("./data.js") : root.LostFoundData;
  const { records, aliases, categoryClues, validation, test } = data;
  const limits = { queryLength: 240, minimumClues: 2, maxResults: 3 };
  const weights = { text: 0.8, category: 0.12, location: 0.08 };

  function fold(text) {
    return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  const replacement = new Map();
  for (const [canonical, ...forms] of aliases) {
    for (const form of forms) replacement.set(fold(form), fold(canonical));
  }
  const escapedForms = [...replacement.keys()].sort((a, b) => b.length - a.length)
    .map(form => form.replace(/[.*+?^$${}()|[\]\\]/g, "\\$&"));
  const aliasPattern = new RegExp(escapedForms.join("|"), "g");

  function normalize(text) {
    return fold(text).replace(aliasPattern, match => replacement.get(match));
  }

  function counts(text, sizes) {
    const features = new Map();
    for (const segment of text.split(" ")) {
      const chars = [...segment];
      for (const size of sizes) {
        for (let i = 0; i + size <= chars.length; i++) {
          const gram = chars.slice(i, i + size).join("");
          features.set(gram, (features.get(gram) || 0) + 1);
        }
      }
    }
    return features;
  }

  const documents = records.map(record => {
    const description = [record.title, record.location, record.details].join(" ");
    const normalized = normalize(description);
    return {
      record,
      normalized,
      plain: counts(fold(description), [2]),
      features: counts(normalized, [2, 3])
    };
  });
  const documentFrequency = new Map();
  for (const doc of documents) {
    for (const key of doc.features.keys()) {
      documentFrequency.set(key, (documentFrequency.get(key) || 0) + 1);
    }
  }
  const idf = new Map([...documentFrequency].map(([key, df]) => [
    key, Math.log((documents.length + 1) / (df + 1)) + 1
  ]));

  function vectorize(features) {
    const values = new Map();
    let total = 0;
    for (const [key, frequency] of features) {
      // 保留索引词表之外的查询特征，让未知描述也影响查询向量的长度。
      const weight = (1 + Math.log(frequency)) * (idf.get(key) || Math.log(documents.length + 1) + 1);
      values.set(key, weight);
      total += weight * weight;
    }
    return { values, norm: Math.sqrt(total) };
  }
  for (const doc of documents) doc.vector = vectorize(doc.features);
  const locations = [...new Set(records.map(record => record.location))];
  const normalizedClues = Object.entries(categoryClues).map(([key, values]) => [key, values.map(normalize)]);

  function calculateScores(query, filter = {}) {
    const safeQuery = String(query).slice(0, limits.queryLength);
    const normalized = normalize(safeQuery);
    const plain = counts(fold(safeQuery), [2]);
    const vector = vectorize(counts(normalized, [2, 3]));
    const categoryMatches = normalizedClues
      .filter(([, clues]) => clues.some(clue => normalized.includes(clue))).map(([key]) => key);
    const locationMatches = locations.filter(location => normalized.includes(normalize(location)));
    const candidates = [];

    for (const doc of documents) {
      const { record } = doc;
      if (filter.category && filter.category !== record.category) continue;
      if (filter.location && filter.location !== record.location) continue;

      let dot = 0;
      let common = 0;
      for (const [gram, weight] of vector.values) dot += weight * (doc.vector.values.get(gram) || 0);
      for (const gram of plain.keys()) if (doc.plain.has(gram)) common++;
      const denominator = vector.norm * doc.vector.norm;
      const text = denominator ? Math.min(1, dot / denominator) : 0;
      const category = Number(categoryMatches.includes(record.category));
      const location = Number(locationMatches.includes(record.location));
      const union = plain.size + doc.plain.size - common;
      candidates.push({
        record,
        normalized: doc.normalized,
        text, category, location,
        score: Math.min(1, weights.text * text + weights.category * category + weights.location * location),
        baseline: union ? common / union : 0
      });
    }
    return { normalized, categoryMatches, locationMatches, candidates };
  }

  function order(candidates, field) {
    return [...candidates].sort((a, b) => b[field] - a[field] || a.record.id.localeCompare(b.record.id));
  }

  function calibrate() {
    const cases = validation.map(([query, expected]) => ({
      best: order(calculateScores(query).candidates, "score")[0], expected
    }));
    const positives = cases.filter(row => row.expected);
    const negatives = cases.filter(row => !row.expected);
    const grid = Array.from({ length: 31 }, (_, index) => (10 + index) / 100);
    const trials = grid.map(threshold => {
      const accepted = positives.filter(({ best, expected }) => best.score >= threshold && best.record.id === expected).length;
      const rejected = negatives.filter(({ best }) => best.score < threshold).length;
      return { threshold, quality: (accepted / positives.length + rejected / negatives.length) / 2 };
    });
    const highest = Math.max(...trials.map(trial => trial.quality));
    const ties = trials.filter(trial => trial.quality === highest);
    return { ...ties[Math.floor((ties.length - 1) / 2)], positiveCount: positives.length, negativeCount: negatives.length };
  }

  const calibration = calibrate();

  function sharedPhrases(query, target) {
    const phrases = new Set();
    const targetWords = target.split(" ");
    for (const word of query.split(" ")) {
      const letters = [...word];
      for (let start = 0; start < letters.length - 1; start++) {
        for (let end = Math.min(letters.length, start + 10); end >= start + 2; end--) {
          const phrase = letters.slice(start, end).join("");
          if (targetWords.some(entry => entry.includes(phrase))) {
            phrases.add(phrase);
            break;
          }
        }
      }
    }
    const selected = [];
    for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
      if (!selected.some(existing => existing.includes(phrase))) selected.push(phrase);
      if (selected.length === 4) break;
    }
    return selected;
  }

  function search(query, filter = {}) {
    const result = calculateScores(query, filter);
    const enoughText = [...result.normalized.replace(/ /g, "")].length >= limits.minimumClues;
    const results = enoughText ? order(result.candidates, "score")
      .filter(candidate => candidate.score >= calibration.threshold).slice(0, limits.maxResults)
      .map(candidate => ({ ...candidate, phrases: sharedPhrases(result.normalized, candidate.normalized) })) : [];
    return { results, enoughText, searched: result.candidates.length, categoryMatches: result.categoryMatches, locationMatches: result.locationMatches };
  }

  function evaluate() {
    const rows = test.map(row => {
      const { candidates } = calculateScores(row.query);
      const baseline = order(candidates, "baseline").filter(item => item.baseline > 0).slice(0, 3);
      const model = order(candidates, "score").filter(item => item.score > 0).slice(0, 3);
      const shown = model.filter(item => item.score >= calibration.threshold);
      return {
        ...row,
        baselineIds: baseline.map(item => item.record.id),
        modelIds: model.map(item => item.record.id),
        shownIds: shown.map(item => item.record.id),
        bestScore: model[0]?.score ?? 0
      };
    });
    const positives = rows.filter(row => row.expected);
    const negatives = rows.filter(row => !row.expected);
    function summarize(field) {
      const ranks = positives.map(row => row[field].indexOf(row.expected) + 1);
      return {
        top1: ranks.filter(rank => rank === 1).length,
        top3: ranks.filter(rank => rank > 0).length,
        mrr3: ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / positives.length
      };
    }
    return {
      calibration,
      positiveCount: positives.length, negativeCount: negatives.length,
      baseline: summarize("baselineIds"), model: summarize("modelIds"),
      shown: summarize("shownIds"),
      rejected: negatives.filter(row => row.shownIds.length === 0).length,
      rows
    };
  }

  const api = { limits, weights, locations, normalize, search, evaluate };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LostFoundEngine = api;
})(globalThis);
