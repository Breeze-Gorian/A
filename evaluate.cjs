"use strict";

const { evaluate } = require("./engine.js");
const result = evaluate();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const { positiveCount, negativeCount, baseline, model, shown, rejected, calibration } = result;
  console.log("排序实验：有对应记录 " + positiveCount + " 条，无对应记录 " + negativeCount + " 条");
  console.table({ Jaccard: baseline, TFIDF: model, Displayed: shown });
  console.log("展示阈值：" + calibration.threshold + "；无对应正确拒绝：" + rejected + "/" + negativeCount);
  console.table(result.rows.map(row => ({
    id: row.id, expected: row.expected || "—", baseline: row.baselineIds.join(","),
    model: row.modelIds.join(","), displayed: row.shownIds.join(","),
    best: row.bestScore.toFixed(3)
  })));
}
