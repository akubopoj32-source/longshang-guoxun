const $ = (id) => document.getElementById(id);
const statusNames = {draft: "草稿", pending: "待复核", confirmed: "已复核", returned: "已退回"};
const fieldStates = {recorded: "已记录", unknown: "待核实", conflict: "待核对"};
const reviewNames = {submit: "提交复核", confirm: "确认记录", return: "退回补充"};
const fieldReviewNames = {confirm: "确认现值", correct: "人工更正", mark_unknown: "标记为待核实"};
let tasks;
let state;
let records = [];
let busy = false;
const activityFormat = new Intl.DateTimeFormat("zh-CN", {dateStyle: "short", timeStyle: "short"});

async function request(path, body) {
  const options = body === undefined ? {} : {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
  };
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "请求失败。"), { code: data.code });
  return data;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function notify(text, error = false) {
  $("notice").textContent = text;
  $("notice").className = error ? "error" : "";
}

function renderList() {
  const filter = $("record-filter").value;
  const query = $("record-search").value.trim().replace(/^#/, "").toLowerCase();
  const visible = records.filter((record) => {
    if (filter && record.status !== filter) return false;
    return !query || [record.location, tasks[record.task].label, record.id]
      .some((value) => value?.toLowerCase().includes(query));
  });
  $("list-empty").hidden = visible.length > 0;
  $("list-empty").textContent = filter || query ? "没有符合筛选条件的记录。" : "还没有巡查记录。";
  $("record-list").replaceChildren();
  for (const record of visible) {
    const item = element("li");
    const button = element("button", undefined, "record-item");
    button.type = "button";
    button.disabled = busy;
    if (state?.id === record.id) button.setAttribute("aria-current", "true");
    button.append(
      element("strong", record.location || "点位待补充"),
      element("span", `${tasks[record.task].label} · ${statusNames[record.status]}`),
      element("span", `#${record.id.slice(0, 8)} · ${record.activity_at ? activityFormat.format(new Date(record.activity_at)) : "无活动时间"}`),
    );
    button.addEventListener("click", () => {
      if (state?.id === record.id || !canLeaveInput()) return;
      run(async () => {
        update(await request(`/api/records/${record.id}`));
        $("turn").reset();
      });
    });
    item.append(button);
    $("record-list").append(item);
  }
}

async function refreshRecords() {
  records = (await request("/api/records")).records;
  renderList();
}

function canLeaveInput() {
  return !($("message").value.trim() || $("photo").files.length || $("review-note").value.trim()
    || hasFieldReviewInput())
    || window.confirm("有尚未保存的内容。要放弃这些内容并切换记录吗？");
}

function hasFieldReviewInput() {
  return !$("field-review-form").hidden && ($("field-review-note").value.trim()
    || (!$("field-review-value-panel").hidden && $("field-review-value").value.trim()));
}

async function run(action) {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  $("review-note").disabled = true;
  notify("正在处理…");
  try {
    await action();
    notify("");
  } catch (error) {
    notify(error.message, true);
  } finally {
    busy = false;
    for (const button of document.querySelectorAll("button")) button.disabled = false;
    $("review-note").disabled = false;
  }
}

function update(data) {
  if (state?.id !== data.id) {
    $("review-note").value = "";
    $("review-history").open = false;
    $("field-review-form").reset();
    $("field-review-key").replaceChildren();
    $("field-review-history").open = false;
  }
  state = data;
  localStorage.setItem("orchard-last-record", data.id);
  const record = data.record;
  const task = tasks[record.task];
  $("task").value = record.task;
  renderList();
  $("record-status").textContent = `${task.label} · 第 ${record.version} 版 · ${statusNames[record.status]}`;
  $("turn").hidden = !["draft", "returned"].includes(record.status);
  $("rules-fallback").hidden = true;
  $("history").hidden = record.turns.length === 0;
  $("review").hidden = record.turns.length === 0;
  $("question").textContent = data.questions[0] || (record.turns.length ? "可以继续补充，或提交复核。" : "请描述现场观察。");
  $("fields").replaceChildren();
  for (const [key, label] of Object.entries(task.fields)) {
    const field = record.fields[key];
    const reviewVersion = field?.review_version;
    const details = element("dd", field ? `${field.value} · ${fieldStates[field.status]}` : "待补充");
    if (reviewVersion) {
      const link = element("a", `查看第 ${reviewVersion} 版人工判断`);
      link.href = `#field-review-${reviewVersion}`;
      link.addEventListener("click", () => { $("field-review-history").open = true; });
      details.append(link);
    }
    for (const evidence of field?.evidence || []) {
      const link = element("a", `第 ${evidence.turn} 轮 · ${evidence.quote || "原图"}`);
      link.href = `#evidence-${evidence.turn}`;
      details.append(link);
    }
    $("fields").append(element("dt", label), details);
  }
  $("turns").replaceChildren();
  for (const turn of record.turns) {
    const entry = element("article", undefined, "evidence");
    entry.id = `evidence-${turn.id}`;
    const source = {model: "图文模型", rules: "本地规则"}[turn.extraction_mode];
    entry.append(element("h3", source ? `第 ${turn.id} 轮 · ${source}` : `第 ${turn.id} 轮`),
      element("p", turn.message ? `巡查员原话：${turn.message}` : "仅上传图片"));
    if (turn.image) {
      const image = element("img");
      image.src = turn.image;
      image.alt = `第 ${turn.id} 轮的巡查照片`;
      entry.append(image, element("p", turn.visual ? `模型视觉线索，待人工核对：${turn.visual}` : "已留存原图，当前无视觉提取结果。"));
      if (turn.visible_count != null) entry.append(element("p", `模型估计照片中可见 ${turn.visible_count} 只，待人工核对。`));
    }
    $("turns").append(entry);
  }
  const alerts = data.evidence_alerts || [];
  $("evidence-alerts").hidden = alerts.length === 0;
  $("alert-list").replaceChildren(...alerts.map((alert) => {
    const item = element("li", `口述 ${alert.reported} 只，照片估计可见 ${alert.visible} 只。`);
    const link = element("a", `查看第 ${alert.turn} 轮原话与照片`);
    link.href = `#evidence-${alert.turn}`;
    item.append(" ", link);
    return item;
  }));
  $("pending").replaceChildren(...(data.pending.length ? data.pending : ["无"]).map((item) => element("li", item)));
  $("revisions").replaceChildren(...record.revisions.filter((change) => change.before).map((change) =>
    element("li", `第 ${change.version} 版 · ${task.fields[change.field]}：${change.before.value} → ${change.after.value}`)));
  if (!$("revisions").children.length) $("revisions").append(element("li", "暂无字段修订。"));
  updateFieldReviews(record, task, alerts);
  $("review-history").hidden = record.reviews.length === 0;
  $("review-entries").replaceChildren(...record.reviews.map((entry) => {
    const time = activityFormat.format(new Date(entry.time));
    const item = element("li", `第 ${entry.version} 版 · ${reviewNames[entry.action]} · ${time}`);
    if (entry.note) item.append(element("span", entry.note, "review-note-text"));
    return item;
  }));
  const lastReview = record.reviews.at(-1);
  const returnNote = record.status === "returned" ? lastReview?.note : "";
  $("return-note").hidden = !returnNote;
  $("return-note").textContent = returnNote ? `退回意见\n${returnNote}` : "";
  $("review-note-panel").hidden = !["pending", "confirmed"].includes(record.status);
  $("actions").replaceChildren();
  if (["draft", "returned"].includes(record.status)) addAction("提交复核", () => changeReview("submit"));
  if (record.status === "pending") addAction("确认当前版本", () => changeReview("confirm"));
  if (["pending", "confirmed"].includes(record.status)) addAction("退回补充", () => changeReview("return"));
  if (record.status === "confirmed") {
    addAction("导出复核记录", exportRecord);
    addAction("导出复查单（Markdown）", exportChecklist);
    addAction("预览打印版", openPrintPreview);
  }
}

function fieldReviewText(entry, task) {
  const prior = entry.before?.value || "待补充";
  return `第 ${entry.version} 版 · ${task.fields[entry.field]} · ${fieldReviewNames[entry.action]} · ${prior} → ${entry.after.value}`;
}

function updateFieldReviews(record, task, alerts) {
  const history = record.field_reviews || [];
  $("field-review-history").hidden = history.length === 0;
  $("field-review-entries").replaceChildren(...history.map((entry) => {
    const item = element("li", fieldReviewText(entry, task));
    item.id = `field-review-${entry.version}`;
    if (entry.note) item.append(element("span", entry.note, "review-note-text"));
    for (const alert of entry.alerts || []) {
      const link = element("a", `第 ${alert.turn} 轮口述 ${alert.reported} 只 · 照片估计可见 ${alert.visible} 只`);
      link.href = `#evidence-${alert.turn}`;
      item.append(element("br"), link);
    }
    return item;
  }));
  const form = $("field-review-form");
  form.hidden = record.status !== "pending";
  if (form.hidden) return;
  const select = $("field-review-key");
  const selected = select.value;
  select.replaceChildren(...Object.entries(task.fields).map(([key, label]) => {
    const option = element("option", label);
    option.value = key;
    return option;
  }));
  if (selected in task.fields) select.value = selected;
  else if (alerts.length) select.value = "quantity";
  renderFieldReview();
}

function renderFieldReview() {
  const record = state.record;
  const field = record.fields[$("field-review-key").value];
  $("field-review-current").textContent = field ? `${field.value} · ${fieldStates[field.status]}` : "该字段尚待补充";
  const evidence = $("field-review-evidence");
  evidence.replaceChildren();
  const sourceTurns = new Set();
  for (const source of field?.evidence || []) {
    const link = element("a", `第 ${source.turn} 轮${source.quote ? ` · ${source.quote}` : "原图"}`);
    link.href = `#evidence-${source.turn}`;
    evidence.append(link);
    sourceTurns.add(source.turn);
  }
  const pictured = record.turns.findLast((turn) => turn.image && sourceTurns.has(turn.id));
  if (pictured) {
    const picture = element("img");
    picture.src = pictured.image;
    picture.alt = `第 ${pictured.id} 轮照片预览`;
    evidence.append(picture);
  }
  const action = $("field-review-action");
  action.options[0].disabled = field?.status !== "recorded";
  if ((!action.value || action.value === "confirm") && action.options[0].disabled) action.value = "mark_unknown";
  const correcting = action.value === "correct";
  $("field-review-value-panel").hidden = !correcting;
  $("field-review-value").required = correcting;
  $("field-review-note").required = correcting;
}

function addAction(label, action) {
  const button = element("button", label);
  button.type = "button";
  button.addEventListener("click", () => run(action));
  $("actions").append(button);
}

async function changeReview(action) {
  if (hasFieldReviewInput()) {
    throw new Error("有尚未保存的字段判断，请先保存或清空。");
  }
  update(await request(`/api/records/${state.id}/review`, {
    action, version: state.record.version, status: state.record.status,
    note: action === "submit" ? "" : $("review-note").value,
  }));
  $("review-note").value = "";
  await refreshRecords();
}

function exportRecord() {
  const data = {
    id: state.id, ...state.record, task_label: tasks[state.record.task].label,
    pending: state.pending, evidence_alerts: state.evidence_alerts,
  };
  download(JSON.stringify(data, null, 2), "json", "application/json");
}

function markdownText(value) {
  return String(value).replace(/\s+/g, " ").trim()
    .replace(/[&<>:\[\]()!*_\x60#~|\\]/g, (character) => `&#${character.charCodeAt(0)};`);
}

function exportChecklist() {
  const record = state.record;
  const task = tasks[record.task];
  const lines = ["# 果园巡查复查单", "", `记录编号 ${state.id}`,
    `任务 ${task.label} · 第 ${record.version} 版 · ${statusNames[record.status]}`, "", "## 巡查记录", ""];
  for (const [key, label] of Object.entries(task.fields)) {
    const field = record.fields[key];
    lines.push(field
      ? `- **${label}** · ${markdownText(field.value)}（${fieldStates[field.status]}）`
      : `- **${label}** · 待补充`);
    for (const evidence of field?.evidence || []) {
      lines.push(`  - 第 ${evidence.turn} 轮${evidence.quote ? `原话「${markdownText(evidence.quote)}」` : "原图"}`);
    }
  }
  lines.push("", "## 待核实事项", "", ...(state.pending.length ? state.pending.map((item) => `- ${markdownText(item)}`) : ["无"]));
  for (const alert of state.evidence_alerts || []) {
    lines.push(`- 第 ${alert.turn} 轮口述 ${alert.reported} 只，模型估计照片可见 ${alert.visible} 只。`);
  }
  if (record.field_reviews?.length) {
    lines.push("", "## 字段复核历史", "");
    for (const entry of record.field_reviews) {
      lines.push(`- ${markdownText(fieldReviewText(entry, task))}`);
      if (entry.note) lines.push(`  - ${markdownText(entry.note)}`);
    }
  }
  lines.push("", "## 复核历史", "");
  for (const entry of record.reviews) {
    lines.push(`- 第 ${entry.version} 版 · ${reviewNames[entry.action]} · ${entry.time}`);
    if (entry.note) lines.push(`  - ${markdownText(entry.note)}`);
  }
  if (record.turns.some((turn) => turn.image)) {
    lines.push("", "原图可在工作台或同版本 JSON 复核记录中查看。");
  }
  download(lines.join("\n") + "\n", "md", "text/markdown;charset=utf-8");
}

function download(content, extension, mime) {
  const url = URL.createObjectURL(new Blob([content], {type: mime}));
  const link = element("a");
  link.href = url;
  link.download = `巡查记录-${state.id.slice(0, 8)}-v${state.record.version}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openPrintPreview() {
  const record = state.record;
  const task = tasks[record.task];
  const sheet = $("print-sheet");
  const title = element("h1", "果园巡查复查单");
  title.id = "print-title";
  sheet.replaceChildren(title, element("p", `记录编号 ${state.id}`),
    element("p", `${task.label} · 第 ${record.version} 版 · ${statusNames[record.status]}`));
  const fields = Object.entries(task.fields).map(([key, label]) => {
    const field = record.fields[key];
    return field ? `${label}　${field.value}（${fieldStates[field.status]}）` : `${label}　待补充`;
  });
  appendPrintList(sheet, "巡查记录", fields);
  appendPrintList(sheet, "待核实事项", state.pending.length ? state.pending : ["无"]);
  if (state.evidence_alerts?.length) {
    appendPrintList(sheet, "图文证据待核对", state.evidence_alerts.map((alert) =>
      `第 ${alert.turn} 轮口述 ${alert.reported} 只，模型估计照片可见 ${alert.visible} 只。`));
  }
  if (record.field_reviews?.length) {
    appendPrintList(sheet, "字段复核历史", record.field_reviews.flatMap((entry) => {
      const description = entry.note ? `${fieldReviewText(entry, task)}　${entry.note}` : fieldReviewText(entry, task);
      const priorAlerts = (entry.alerts || []).map((alert) =>
        `复核前第 ${alert.turn} 轮口述 ${alert.reported} 只，模型估计照片可见 ${alert.visible} 只。`);
      return [description, ...priorAlerts];
    }));
  }
  appendPrintList(sheet, "复核历史", record.reviews.map((entry) =>
    `第 ${entry.version} 版 · ${reviewNames[entry.action]} · ${entry.time}${entry.note ? `　${entry.note}` : ""}`));
  sheet.append(element("h2", "现场证据"));
  for (const turn of record.turns) {
    const figure = element("figure");
    if (turn.image) {
      const picture = element("img");
      picture.src = turn.image;
      picture.alt = `第 ${turn.id} 轮原图`;
      figure.append(picture);
    }
    figure.append(element("figcaption", `第 ${turn.id} 轮 · ${turn.message || "仅上传照片"}`));
    sheet.append(figure);
  }
  $("print-status").textContent = "";
  $("save-pdf").hidden = !window.orchardDesktop;
  $("print-preview").showModal();
}

function appendPrintList(sheet, heading, lines) {
  const list = element("ul");
  list.append(...lines.map((line) => element("li", line)));
  sheet.append(element("h2", heading), list);
}

function readImage(file) {
  if (!file) return Promise.resolve("");
  if (file.size > 4 * 1024 * 1024) return Promise.reject(new Error("图片不能超过 4 MB。"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("无法读取图片。"));
    reader.readAsDataURL(file);
  });
}

$("new-record").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!canLeaveInput()) return;
  run(async () => {
    update(await request("/api/records", {task: $("task").value}));
    $("turn").reset();
    $("record-filter").value = "";
    $("record-search").value = "";
    await refreshRecords();
  });
});

$("turn").addEventListener("submit", (event) => {
  event.preventDefault();
  const rulesOnly = event.submitter === $("rules-fallback");
  run(async () => {
    const image = await readImage($("photo").files[0]);
    try {
      update(await request(`/api/records/${state.id}/turn`, {
        message: $("message").value, image, version: state.record.version,
        status: state.record.status, rules_only: rulesOnly,
      }));
    } catch (error) {
      if (error.code === "model_unavailable") $("rules-fallback").hidden = false;
      throw error;
    }
    $("turn").reset();
    await refreshRecords();
  });
});

$("record-filter").addEventListener("change", renderList);
$("record-search").addEventListener("input", renderList);
$("field-review-key").addEventListener("change", () => {
  $("field-review-value").value = "";
  $("field-review-note").value = "";
  renderFieldReview();
});
$("field-review-action").addEventListener("change", renderFieldReview);
$("field-review-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const data = await request(`/api/records/${state.id}/field-review`, {
      field: $("field-review-key").value, action: $("field-review-action").value,
      value: $("field-review-value").value, note: $("field-review-note").value,
      version: state.record.version, status: state.record.status,
    });
    $("field-review-value").value = "";
    $("field-review-note").value = "";
    update(data);
    await refreshRecords();
  });
});
$("close-preview").addEventListener("click", () => $("print-preview").close());
$("print-preview").addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
$("print-record").addEventListener("click", () => {
  if (!window.orchardDesktop) {
    window.print();
    return;
  }
  run(async () => {
    try {
      const printed = await window.orchardDesktop.printChecklist();
      $("print-status").textContent = printed ? "复查单已发送到打印机。" : "打印取消或未完成。";
    } catch {
      $("print-status").textContent = "打印失败，请检查打印机后重试。";
    }
  });
});
$("save-pdf").addEventListener("click", () => run(async () => {
  try {
    const filename = `巡查复查单-${state.id.slice(0, 8)}-v${state.record.version}.pdf`;
    if (await window.orchardDesktop.saveChecklistPdf(filename)) $("print-status").textContent = "PDF 已保存。";
  } catch {
    $("print-status").textContent = "保存 PDF 失败，请检查保存位置后重试。";
  }
}));

run(async () => {
  const config = await request("/api/config");
  tasks = config.tasks;
  $("mode").textContent = config.mode === "model"
    ? "图文模型模式 · 输入将发送到已配置的模型服务"
    : "规则演示 · 支持上传和查看原图，未启用图像识别";
  for (const [key, task] of Object.entries(tasks)) {
    const option = element("option", task.label);
    option.value = key;
    $("task").append(option);
  }
  await refreshRecords();
  const previous = localStorage.getItem("orchard-last-record");
  if (records.some((record) => record.id === previous)) {
    update(await request(`/api/records/${previous}`));
  } else {
    localStorage.removeItem("orchard-last-record");
  }
});
