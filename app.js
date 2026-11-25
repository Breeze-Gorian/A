(function () {
  "use strict";

  const { categories, records, validation, test, examples } = LostFoundData;
  const { limits, weights, locations, normalize, search, evaluate } = LostFoundEngine;
  const byId = id => document.getElementById(id);
  const routeNames = ["match", "records", "experiment"];
  const matchForm = byId("match-form");
  const query = byId("query");
  const matchCategory = byId("match-category");
  const matchLocation = byId("match-location");
  const recordQuery = byId("record-query");
  const recordCategory = byId("record-category");
  const recordLocation = byId("record-location");
  const output = byId("results");
  const experiment = byId("experiment-content");
  const escapeMap = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escape = value => String(value).replace(/[&<>"']/g, character => escapeMap[character]);
  const asPercent = rate => (rate * 100).toFixed(1) + "%";
  const asPoints = score => (score * 100).toFixed(1);

  function populate(select, options) {
    for (const [value, label] of options) select.add(new Option(label, value));
  }
  for (const select of [matchCategory, recordCategory]) populate(select, Object.entries(categories));
  for (const select of [matchLocation, recordLocation]) populate(select, locations.map(value => [value, value]));

  function renderRoute() {
    const path = location.hash.slice(1);
    if (path === "main") return;
    const active = routeNames.includes(path) ? path : "match";
    for (const id of routeNames) byId(id).hidden = id !== active;
    for (const link of document.querySelectorAll("nav a")) {
      if (link.hash === "#" + active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (active === "experiment" && !experiment.hasChildNodes()) renderExperiment();
    window.scrollTo(0, 0);
  }

  function showCount() {
    byId("query-count").textContent = query.value.length + " / " + limits.queryLength;
  }

  function empty(title, message) {
    return '<div class="empty"><strong>' + escape(title) + '</strong>' + escape(message) + '</div>';
  }

  function resultCard(result, index) {
    const { record, phrases, score, text, category, location } = result;
    const highlights = phrases.map(phrase => "<span>" + escape(phrase) + "</span>").join("");
    return [
      '<article class="result' + (index === 0 ? ' lead' : '') + '">',
      '<div class="result-heading"><h3>' + escape(record.title) + '</h3><span class="score">匹配分 ' + asPoints(score) + '</span></div>',
      '<p class="result-meta">' + escape([record.id, categories[record.category], record.location, record.date].join(" · ")) + '</p>',
      '<p class="description">' + escape(record.details) + '</p>',
      highlights ? '<div class="clues">共现片段 ' + highlights + '</div>' : "",
      '<details><summary>查看评分依据</summary>',
      '<p>文本得分 ' + asPoints(text * weights.text) + ' / 80 · 类别 ' + (category ? "一致" : "未命中") + '（' + asPoints(category * weights.category) + ' 分） · 地点 ' + (location ? "一致" : "未命中") + '（' + asPoints(location * weights.location) + ' 分）。匹配分是排序分值。</p></details>',
      '</article>'
    ].join("");
  }

  function runSearch() {
    const text = query.value.trim();
    const { results, enoughText, searched } = search(text, {
      category: matchCategory.value,
      location: matchLocation.value
    });
    byId("result-count").textContent = results.length + " 条候选";
    byId("search-status").textContent = text ? "已检索 " + searched + " 条记录 · 最多显示 3 条" : "";
    if (!enoughText) {
      output.innerHTML = empty("线索太少", "请至少补充物品名称，最好带上颜色、地点或明显特征。");
    } else if (!searched) {
      output.innerHTML = empty("当前筛选没有记录", "试试放宽类别或地点筛选。");
    } else if (!results.length) {
      output.innerHTML = empty("暂未发现足够相似的记录", "补充明显特征，或放宽筛选后再试。");
    } else {
      output.innerHTML = results.map(resultCard).join("");
    }
  }

  function fillQuery(text) {
    query.value = text;
    matchCategory.value = "";
    matchLocation.value = "";
    showCount();
    runSearch();
  }

  matchForm.addEventListener("submit", event => {
    event.preventDefault();
    runSearch();
  });
  query.addEventListener("input", showCount);
  byId("examples").addEventListener("click", event => {
    const button = event.target.closest("[data-example]");
    if (button) fillQuery(examples[Number(button.dataset.example)]);
  });

  function renderRecords() {
    const text = normalize(recordQuery.value);
    const filtered = records.filter(record =>
      (!recordCategory.value || record.category === recordCategory.value) &&
      (!recordLocation.value || record.location === recordLocation.value) &&
      (!text || normalize([record.id, record.title, record.details, record.location, categories[record.category]].join(" ")).includes(text))
    );
    byId("record-count").textContent = filtered.length + " / " + records.length + " 条";
    byId("record-list").innerHTML = filtered.map(record => [
      '<article class="card record"><span class="small-tag">' + escape(categories[record.category]) + '</span>',
      '<h2>' + escape(record.title) + '</h2>',
      '<p class="result-meta">' + escape([record.id, record.location, record.date].join(" · ")) + '</p>',
      '<p class="description">' + escape(record.details) + '</p></article>'
    ].join("")).join("") || empty("没有符合条件的记录", "可尝试更换关键词或清除筛选。");
  }
  recordQuery.addEventListener("input", renderRecords);
  recordCategory.addEventListener("change", renderRecords);
  recordLocation.addEventListener("change", renderRecords);

  const algorithmNames = ["基线 · 二元字符集合 Jaccard", "TF-IDF＋类别与地点", "实际展示结果 · 应用阈值"];

  function renderExperiment() {
    const result = evaluate();
    const { positiveCount, negativeCount, baseline, model, shown, calibration } = result;
    const rankings = [baseline, model, shown].map((row, i) =>
      '<tr><th scope="row">' + algorithmNames[i] + '</th><td>' + row.top1 + ' / ' + positiveCount + '</td><td>' +
      row.top3 + ' / ' + positiveCount + '</td><td>' + row.mrr3.toFixed(3) + '</td></tr>'
    ).join("");
    experiment.innerHTML = [
      '<div class="experiment-metrics">',
      '<div class="card metric"><span>招领样本</span><strong>' + records.length + '</strong><small>用于建立检索索引</small></div>',
      '<div class="card metric"><span>留出测试</span><strong>' + test.length + '</strong><small>' + positiveCount + ' 有对应 · ' + negativeCount + ' 无对应</small></div>',
      '<div class="card metric"><span>无对应正确拒绝</span><strong>' + result.rejected + ' / ' + negativeCount + '</strong><small>展示分 ≥ ' + asPoints(calibration.threshold) + '</small></div></div>',
      '<section class="card experiment-card" aria-labelledby="ranking-title"><h2 id="ranking-title">检索排序对比</h2>',
      '<p>Top 1 和 Top 3 分别统计正确物品排进第 1 名和前 3 名的查询数。MRR@3 对更靠前的命中赋予更高权重。</p>',
      '<div class="table-scroll" tabindex="0" role="region" aria-label="排序对比数据"><table><thead><tr><th scope="col">方法</th><th scope="col">Top 1</th><th scope="col">Top 3</th><th scope="col">MRR@3</th></tr></thead><tbody>' + rankings + '</tbody></table></div>',
      '<p class="table-caption">排序比较针对有对应记录的 ' + positiveCount + ' 条查询。阈值根据另外 ' + validation.length + ' 条标定查询选择，标定目标得分为 ' + asPercent(calibration.quality) + '。</p></section>',
      '<section class="card experiment-card" aria-labelledby="cases-title"><div class="section-top"><h2 id="cases-title">测试明细</h2><button type="button" id="toggle-cases" class="text-button" aria-pressed="true">显示全部案例</button></div>',
      '<p>点击“试跑”可以把测试输入带回匹配页。表格默认显示系统首选与标注不一致、或有对应记录却未展示的案例。</p>',
      '<div class="table-scroll" tabindex="0" role="region" aria-label="测试明细数据"><table class="case-table"><thead><tr><th scope="col">编号</th><th scope="col">失物线索</th><th scope="col">参考答案</th><th scope="col">基线首选</th><th scope="col">系统首选</th><th scope="col">核对</th></tr></thead><tbody id="case-rows"></tbody></table></div></section>',
      '<section class="card experiment-card" aria-labelledby="method-title"><h2 id="method-title">算法与数据</h2>',
      '<p>将同义描述归一化，提取中文二元与三元字符片段，按 TF-IDF 赋权，再用余弦相似度计算文本得分。总分来自文本相似度（80%）、类别命中（12%）和地点命中（8%）。</p>',
      '<p>招领语料、标定查询和测试查询均为 AI 辅助编写的模拟样本。结果可复现，用于课堂比较。真实使用前需要重新采集和标注数据。</p></section>'
    ].join("");

    function renderCases(onlyErrors) {
      const rows = result.rows.filter(row => !onlyErrors || (row.shownIds[0] || null) !== row.expected);
      byId("case-rows").innerHTML = rows.map(row => {
        const correct = (row.shownIds[0] || null) === row.expected;
        const status = correct ? "一致" : (row.expected ? "需核对" : "误报");
        return '<tr><th scope="row">' + escape(row.id) + '</th><td>' + escape(row.query) + '</td><td>' +
          escape(row.expected || "无对应") + '</td><td>' + escape(row.baselineIds[0] || "—") + '</td><td>' +
          escape(row.shownIds[0] || "未展示") + '</td><td><span class="' + (correct ? "status-ok" : "status-review") + '">' +
          status + '</span> <button type="button" class="text-button" data-case="' + escape(row.id) + '">试跑</button></td></tr>';
      }).join("") || '<tr><td colspan="6">当前测试没有首选不一致的案例。</td></tr>';
    }
    renderCases(true);
    byId("toggle-cases").addEventListener("click", event => {
      const onlyErrors = event.currentTarget.getAttribute("aria-pressed") !== "true";
      event.currentTarget.setAttribute("aria-pressed", String(onlyErrors));
      event.currentTarget.textContent = onlyErrors ? "显示全部案例" : "仅看不一致";
      renderCases(onlyErrors);
    });
    byId("case-rows").addEventListener("click", event => {
      const button = event.target.closest("[data-case]");
      if (!button) return;
      const sample = test.find(row => row.id === button.dataset.case);
      if (!sample) return;
      fillQuery(sample.query);
      location.hash = "#match";
      requestAnimationFrame(() => query.focus({ preventScroll: true }));
    });
  }

  byId("results").innerHTML = empty("输入失物描述后开始查询", "可以先选择左侧示例，查看候选记录和评分依据。");
  showCount();
  renderRecords();
  window.addEventListener("hashchange", renderRoute);
  renderRoute();
})();
