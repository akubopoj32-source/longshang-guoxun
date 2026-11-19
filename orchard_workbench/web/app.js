const $ = (id) => document.getElementById(id);
const statusNames = {draft: "草稿", pending: "待复核", confirmed: "已复核", returned: "已退回"};
const fieldStates = {recorded: "已记录", unknown: "待核实", conflict: "待核对"};
const reviewNames = {submit: "提交复核", confirm: "确认记录", return: "退回补充"};
const fieldReviewNames = {confirm: "确认现值", correct: "人工更正", mark_unknown: "标记为待核实"};
const fieldQuestions = {
  trap: "诱捕监测需要记录哪些字段？",
  orchard: "果园异常巡查需要记录哪些字段？",
  trapObservation: "诱捕器巡查时，疑似虫体的现场观察如何填写？",
  orchardObservation: "果园异常巡查如何记录叶片异常和影响范围？",
  photo: "照片模糊或覆盖不足时怎么补拍和复核？",
  countConflict: "诱捕监测口述数量与照片数量不一致时怎么人工复核？",
  unknown: "不知道数量时如何填写巡查记录？",
};
let tasks;
let state;
let records = [];
let busy = false;
let knowledgePending = false;
let refreshingQueue = false;
let queueRequest = 0;
let queueStatus = "pending";
let selectedField;
let selectedTurn;
let mode;
let modelName = "";
let connectionState = "connecting";
let pendingTurn;
let turnProcessing = "";
let inspectorEditor;
let inspectorsBusy = false;
const activityFormat = new Intl.DateTimeFormat("zh-CN", {dateStyle: "short", timeStyle: "short"});
const dateFormat = new Intl.DateTimeFormat("sv-SE", {year: "numeric", month: "2-digit", day: "2-digit"});
const syncFormat = new Intl.DateTimeFormat("zh-CN", {hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});

async function request(path, body) {
  const options = body === undefined ? {} : {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
  };
  options.signal = AbortSignal.timeout(body === undefined ? 8000 : 45000);
  let response;
  let data;
  try {
    response = await fetch(path, options);
    data = await response.json();
  } catch {
    const message = "暂未收到巡查服务响应。请打开「连接状态」重试。";
    showConnection("offline", message);
    throw Object.assign(new Error(message), {code: "connection"});
  }
  if (!response.ok) {
    if (response.status === 403) showConnection("offline", "访问被拒绝，请检查当前服务的联调令牌。");
    throw Object.assign(new Error(data.error || "请求失败。"), {code: data.code, status: response.status});
  }
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

function showConnection(status, message = "") {
  connectionState = status;
  const labels = {connecting: "正在连接", online: "已连接", offline: "连接异常"};
  const statusText = labels[status];
  const text = `${$("connection-target").textContent} · ${statusText}`;
  if ($("service-status").textContent !== text) $("service-status").textContent = text;
  $("service-status").dataset.state = status;
  $("connection-state").textContent = statusText;
  $("connection-feedback").textContent = message;
}

function showModelStatus(degraded = false) {
  const label = degraded ? "图文模型上次处理失败，可用规则保存"
    : mode === "model" ? (modelName ? `图文模型 · ${modelName}` : "图文模型已配置") : "本地规则模式";
  $("mode").textContent = label;
  $("mode").dataset.mode = degraded ? "degraded" : mode;
  $("connection-model").textContent = !degraded && mode === "model"
    ? `${label}。使用模型处理时，本轮输入会发送到已配置的模型服务。`
    : label;
}

function renderList() {
  const task = $("record-task").value;
  const date = $("record-date").value;
  const query = $("record-search").value.trim().replace(/^#/, "").toLowerCase();
  const counts = {pending: 0, returned: 0, confirmed: 0, draft: 0, "": records.length};
  for (const record of records) counts[record.status]++;
  for (const button of $("queue-tabs").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.status === queueStatus));
    button.querySelector("span").textContent = counts[button.dataset.status];
  }
  const visible = records.filter((record) => {
    if (queueStatus && record.status !== queueStatus) return false;
    if (task && record.task !== task) return false;
    if (date && (!record.activity_at || dateFormat.format(new Date(record.activity_at)) !== date)) return false;
    return !query || [record.location, tasks[record.task].label, record.id, record.inspector_name, record.inspector_username]
      .some((value) => value?.toLowerCase().includes(query));
  });
  $("list-empty").hidden = visible.length > 0;
  $("list-empty").textContent = task || date || query ? "没有符合筛选条件的记录。"
    : queueStatus ? `暂无${statusNames[queueStatus]}记录。` : "还没有巡查记录。";
  const focusedRecord = document.activeElement?.dataset.recordId;
  $("record-list").replaceChildren();
  for (const record of visible) {
    const item = element("li");
    const button = element("button", undefined, "record-item");
    button.type = "button";
    button.dataset.recordId = record.id;
    button.disabled = busy;
    if (state?.id === record.id) button.setAttribute("aria-current", "true");
    button.append(
      element("strong", record.location || "点位待补充"),
      element("span", [tasks[record.task].label, record.inspector_name].filter(Boolean).join(" · "), "record-task"),
      statusBadge(record.status),
      element("span", `#${record.id.slice(0, 8)} · ${record.activity_at ? activityFormat.format(new Date(record.activity_at)) : "无活动时间"}`, "record-time"),
    );
    button.addEventListener("click", () => {
      if (state?.id === record.id || !canLeaveInput()) return;
      run(async () => {
        update(await request(`/api/records/${record.id}`));
      });
    });
    item.append(button);
    $("record-list").append(item);
    if (focusedRecord === record.id) button.focus({preventScroll: true});
  }
}

function statusBadge(status) {
  return element("span", statusNames[status], `badge badge-${status}`);
}

function selectQueue(status, clearFilters = false) {
  queueStatus = status;
  if (clearFilters) {
    $("record-search").value = "";
    $("record-task").value = "";
    $("record-date").value = "";
  }
  renderList();
}

async function refreshRecords({background = false} = {}) {
  if (background && (busy || refreshingQueue || document.hidden)) return;
  const requestId = ++queueRequest;
  refreshingQueue = true;
  try {
    const incoming = (await request("/api/records")).records;
    if (requestId !== queueRequest || (background && busy)) return;
    const changed = JSON.stringify(incoming) !== JSON.stringify(records);
    records = incoming;
    if (changed || !background) renderList();
    const refreshedAt = syncFormat.format(new Date());
    $("queue-sync").textContent = `已刷新 ${refreshedAt}`;
    $("connection-refresh").textContent = refreshedAt;
    $("queue-sync").classList.remove("error");
    if (connectionState !== "online") showConnection("online");
  } catch (error) {
    if (requestId !== queueRequest) return;
    $("queue-sync").textContent = "刷新失败，点击「刷新」重试。";
    $("queue-sync").classList.add("error");
    if (!background) throw error;
  } finally {
    if (requestId === queueRequest) refreshingQueue = false;
  }
}

function canLeaveInput() {
  return !hasUnsavedInput()
    || window.confirm("有尚未保存的内容。要放弃这些内容并切换记录吗？");
}

function hasUnsavedInput() {
  return hasTurnInput() || $("review-note").value.trim()
    || hasFieldReviewInput();
}

function hasFieldReviewInput() {
  return !$("field-review-form").hidden && ($("field-review-note").value.trim()
    || (!$("field-review-value-panel").hidden && $("field-review-value").value.trim()));
}

async function run(action) {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  const inputs = document.querySelectorAll("#record-workspace textarea, #record-workspace input, #record-workspace select, #task");
  for (const input of inputs) input.disabled = true;
  notify("正在处理…");
  try {
    const message = await action();
    notify(message || "");
  } catch (error) {
    notify(error.message, true);
  } finally {
    busy = false;
    for (const button of document.querySelectorAll("button")) button.disabled = false;
    $("ask-knowledge").disabled = knowledgePending;
    $("field-knowledge").disabled = knowledgePending;
    for (const input of inputs) input.disabled = false;
    updateTurnButtons();
  }
}

function update(data) {
  const switchingRecord = state?.id !== data.id;
  if (switchingRecord) {
    $("review-note").value = "";
    $("review-note-panel").open = false;
    $("review-history").open = false;
    $("field-review-form").reset();
    $("field-review-history").open = false;
    selectedField = undefined;
    selectedTurn = undefined;
    pendingTurn = undefined;
    $("turn").reset();
    $("rules-fallback").hidden = true;
    setTurnFeedback("");
  }
  state = data;
  localStorage.setItem("orchard-last-record", data.id);
  const record = data.record;
  const task = tasks[record.task];
  $("task").value = record.task;
  renderList();
  $("record-empty").hidden = true;
  $("record-workspace").hidden = false;
  $("record-title").textContent = record.fields.location?.value || "点位待补充";
  $("record-badge").replaceWith(Object.assign(statusBadge(record.status), {id: "record-badge"}));
  $("record-status").textContent = `${task.label} · #${data.id.slice(0, 8)} · 第 ${record.version} 版`;
  $("turn").hidden = !canWriteTurn() && !hasTurnInput();
  updateTurnButtons();
  $("review").hidden = record.turns.length === 0;
  $("question").hidden = record.turns.length > 0;
  const alerts = data.evidence_alerts || [];
  renderProgress(data, task);
  if (switchingRecord && alerts.length) {
    selectedField = "quantity";
    selectedTurn = alerts.at(-1).turn;
  } else if (switchingRecord) {
    selectedField = Object.keys(task.fields)[0];
    selectedTurn = record.turns.findLast((turn) => turn.image)?.id ?? record.turns.at(-1)?.id;
  }
  if (switchingRecord || record.turns.length !== $("evidence-turn").options.length) {
    $("evidence-turn").replaceChildren(...record.turns.map((turn) => new Option(`第 ${turn.id} 轮`, turn.id)));
  }
  renderFields(task, record, alerts);
  renderEvidence();
  $("evidence-alerts").hidden = alerts.length === 0;
  $("alert-list").replaceChildren(...alerts.map((alert) => {
    const item = element("li", `口述 ${alert.reported} 只，照片估计可见 ${alert.visible} 只。`);
    const button = element("button", `核对第 ${alert.turn} 轮证据`, "text-button");
    button.type = "button";
    button.addEventListener("click", () => selectField("quantity", alert.turn));
    item.append(button);
    return item;
  }));
  $("pending-count").textContent = data.pending.length ? `· ${data.pending.length} 项` : "";
  $("pending").replaceChildren(...(data.pending.length ? data.pending : ["无"]).map((item) => element("li", item)));
  $("revisions").replaceChildren(...record.revisions.filter((change) => change.before).map((change) =>
    element("li", `第 ${change.version} 版 · ${task.fields[change.field]}：${change.before.value} → ${change.after.value}`)));
  if (!$("revisions").children.length) $("revisions").append(element("li", "暂无字段修订。"));
  updateFieldReviews(record, task, switchingRecord);
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
  $("return-note").textContent = returnNote ? `退回意见：${returnNote}` : "";
  $("review-note-panel").hidden = !["pending", "confirmed"].includes(record.status);
  $("actions").replaceChildren();
  if (record.turns.length && ["draft", "returned"].includes(record.status)) addAction("提交复核", () => changeReview("submit"));
  if (record.status === "pending") addAction("确认当前版本", () => changeReview("confirm"));
  if (["pending", "confirmed"].includes(record.status)) addAction("退回补充", () => changeReview("return"), "secondary");
  if (record.status === "confirmed") {
    addAction("预览打印版", openPrintPreview);
    addAction("导出复核记录", exportRecord, "secondary");
    addAction("导出复查单（Markdown）", exportChecklist, "secondary");
  }
}

function canWriteTurn() {
  return ["draft", "returned"].includes(state?.record.status);
}

function hasTurnInput() {
  return $("message").value.trim() || $("photo").files.length;
}

function updateTurnButtons() {
  $("submit-turn").disabled = busy || !canWriteTurn() || !hasTurnInput() || Boolean(pendingTurn);
  $("rules-fallback").disabled = $("submit-turn").disabled;
  $("sync-turn").hidden = !pendingTurn;
}

function setTurnFeedback(message, status = "") {
  const feedback = $("turn-feedback");
  feedback.textContent = message;
  feedback.dataset.state = status;
  feedback.classList.toggle("error", status === "error");
}

function turnInputs(turn) {
  return [turn.message && "文字", turn.image && "照片"].filter(Boolean).join(" + ");
}

function renderWorkflow(record, pending, questions, completed, total) {
  const latest = record.turns.at(-1);
  const editable = ["draft", "returned"].includes(record.status);
  const needsAttention = Boolean(questions[0] || pending.length);
  const engine = {model: "图文模型", rules: "本地规则"}[latest?.extraction_mode];
  const reviewState = {draft: "待提交", returned: "已退回补充", pending: "待人工复核", confirmed: "已人工确认"};
  const active = turnProcessing ? "extract" : !latest && record.status === "draft" ? "input"
    : editable && (needsAttention || record.status === "returned") ? "check" : "review";
  const workflowMode = $("workflow-mode");
  workflowMode.hidden = !engine;
  workflowMode.textContent = engine ? `最近一轮 · ${engine}` : "";

  const steps = {
    input: [latest ? `${record.turns.length} 轮 · ${turnInputs(latest)}` : "等待巡查输入", latest ? "done" : "waiting"],
    extract: [turnProcessing || (latest ? `${completed}/${total} 项已记录` : "等待提取"), latest && !turnProcessing ? "done" : "waiting"],
    check: [!latest ? "等待提取" : editable && questions[0] ? "有待补充信息"
      : pending.length ? `${pending.length} 项待核实` : "字段可供复核", !latest ? "waiting" : needsAttention ? "attention" : "done"],
    review: [reviewState[record.status], record.status === "confirmed" ? "done"
      : ["pending", "returned"].includes(record.status) ? "attention" : "waiting"],
  };
  for (const [step, [detail, stepState]] of Object.entries(steps)) {
    const item = $(`workflow-${step}`);
    item.dataset.state = stepState;
    item.setAttribute("aria-current", step === active ? "step" : "false");
    $(`workflow-${step}-detail`).textContent = detail;
  }
}

function renderProgress({record, pending, questions, evidence_alerts}, task) {
  const hasCountConflict = evidence_alerts?.length;
  const statuses = Object.entries(task.fields).map(([key, label]) => {
    const status = key === "quantity" && hasCountConflict ? "conflict" : record.fields[key]?.status;
    return {label, text: fieldStates[status] || "待补充", complete: status === "recorded"};
  });
  const next = {
    draft: record.turns.length ? questions[0] || (pending.length ? "可补充现场信息，或将待核实事项一并提交。" : "可以提交复核。")
      : "录入文字或照片，开始本轮巡查。",
    returned: questions[0] || "请按退回意见补充证据，再提交复核。",
    pending: pending.length ? "请核对证据与待核实事项，再确认或退回。" : "请核对证据后确认当前版本。",
    confirmed: "可预览或导出本版复查单。",
  };
  renderWorkflow(record, pending, questions, statuses.filter((item) => item.complete).length, statuses.length);
  $("record-progress").hidden = false;
  const followUp = ["draft", "returned"].includes(record.status) && questions[0];
  $("record-progress").dataset.attention = String(Boolean(followUp || pending.length && record.status === "pending"));
  $("record-next").textContent = `${followUp ? "追问 · " : ""}${next[record.status]}`;
  $("record-unresolved").replaceChildren(...statuses.filter((item) => record.turns.length && !item.complete).map((item) =>
    element("li", `${item.label} · ${item.text}`, "badge badge-pending")));
  const action = $("next-action");
  const supplement = Boolean(followUp || record.status === "returned");
  const inspectPending = record.status === "pending" && pending.length > 0;
  action.hidden = !supplement && !inspectPending;
  action.dataset.action = supplement ? "supplement" : "review";
  action.textContent = supplement ? "补充信息" : "查看待核实";
}

$("next-action").addEventListener("click", (event) => {
  if (event.currentTarget.dataset.action === "supplement") {
    $("message").focus();
  } else {
    $("pending-panel").open = true;
    $("pending-panel").querySelector("summary").focus();
  }
});

function renderFields(task, record, alerts) {
  $("fields").replaceChildren();
  for (const [key, label] of Object.entries(task.fields)) {
    const field = record.fields[key];
    const item = element("li");
    const button = element("button", undefined, "field-button");
    button.type = "button";
    button.dataset.field = key;
    button.setAttribute("aria-pressed", String(key === selectedField));
    const conflict = field?.status === "conflict" || (key === "quantity" && alerts.length > 0);
    const manuallyVerified = field?.status === "recorded" && field.review_version;
    const labelText = conflict ? "待核对" : manuallyVerified ? "人工复核" : fieldStates[field?.status] || "待补充";
    button.append(element("span", label, "field-name"), element("strong", field?.value || "—", "field-value"),
      element("span", labelText, `badge ${conflict ? "badge-pending" : manuallyVerified ? "badge-confirmed" : "badge-draft"}`));
    button.addEventListener("click", () => selectField(key));
    item.append(button);
    $("fields").append(item);
  }
}

function selectField(key, turn) {
  if (busy) return;
  if (selectedField !== key) {
    if (hasFieldReviewInput() && !window.confirm("要放弃未保存的字段判断并切换字段吗？")) return;
    $("field-review-form").reset();
    selectedField = key;
    for (const button of $("fields").querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.field === key));
    }
    renderFieldReview(true);
  }
  const alert = key === "quantity" ? state.evidence_alerts?.at(-1) : null;
  const fieldEvidence = state.record.fields[key]?.evidence?.findLast((item) => !item.superseded);
  selectedTurn = turn ?? alert?.turn ?? fieldEvidence?.turn ?? selectedTurn;
  renderEvidence();
}

function renderEvidence() {
  const record = state.record;
  const turn = record.turns.find((item) => item.id === selectedTurn) || record.turns.at(-1);
  $("evidence-empty").hidden = Boolean(turn);
  $("evidence-detail").hidden = !turn;
  $("turn-picker").hidden = record.turns.length < 2;
  if (!turn) {
    $("evidence-image").removeAttribute("src");
    return;
  }
  selectedTurn = turn.id;
  const field = record.fields[selectedField];
  const effectiveTurns = new Set(field?.evidence?.filter((item) => !item.superseded).map((item) => item.turn));
  const historicalTurns = new Set(field?.evidence?.filter((item) => item.superseded).map((item) => item.turn));
  for (const option of $("evidence-turn").options) {
    const number = Number(option.value);
    const label = effectiveTurns.has(number) ? " · 字段依据" : historicalTurns.has(number) ? " · 历史依据" : "";
    option.textContent = `第 ${number} 轮${label}`;
  }
  $("evidence-turn").value = turn.id;
  const source = {model: "图文模型", rules: "本地规则"}[turn.extraction_mode];
  $("evidence-source").textContent = source ? `第 ${turn.id} 轮 · ${source}` : `第 ${turn.id} 轮`;
  $("evidence-source").dataset.engine = turn.extraction_mode || "";
  $("evidence-inputs").textContent = turnInputs(turn);
  const taskFields = tasks[record.task].fields;
  const links = Object.entries(taskFields).filter(([key]) =>
    record.fields[key]?.evidence?.some((item) => item.turn === turn.id && !item.superseded));
  $("evidence-fields-row").hidden = links.length === 0;
  $("evidence-field-links").replaceChildren(...links.map(([key, fieldLabel]) => {
    const button = element("button", fieldLabel, "secondary compact");
    button.type = "button";
    button.addEventListener("click", () => {
      selectField(key, turn.id);
      if (selectedField === key) $("fields").querySelector(`[data-field="${key}"]`)?.focus({preventScroll: true});
    });
    return button;
  }));
  $("evidence-message").textContent = turn.message || "本轮未填写文字。";
  const label = taskFields[selectedField];
  const linked = field?.evidence?.filter((item) => item.turn === turn.id) || [];
  const quotes = [...new Set(linked.map((item) => item.quote
    ? item.quote + (item.superseded ? "（已被更正）" : "") : "").filter(Boolean))];
  const linkage = linked.every((item) => item.superseded) ? "历史依据" : "字段依据";
  $("evidence-linkage").textContent = linked.length
    ? `${label}${linkage}${quotes.length ? ` · ${quotes.join(" / ")}` : " · 本轮原图"}`
    : `本轮未关联到「${label}」字段。`;
  $("evidence-photo").hidden = !turn.image;
  $("evidence-no-photo").hidden = Boolean(turn.image);
  $("evidence-visual").hidden = !turn.image;
  if (!turn.image) {
    $("evidence-image").removeAttribute("src");
    return;
  }
  const photo = $("evidence-image");
  photo.src = turn.image;
  photo.alt = `第 ${turn.id} 轮巡查原图`;
  const quality = turn.photo_quality === "limited" ? "照片细节或覆盖有限，需人工核对。"
    : turn.visual ? "" : "已留存原图，当前无视觉提取结果。";
  $("evidence-visual-text").textContent = [turn.visual, quality].filter(Boolean).join(" ");
  $("evidence-count").textContent = turn.visible_count == null ? "" : `模型估计可见 ${turn.visible_count} 只，待人工核对。`;
}

function fieldReviewText(entry, task) {
  const prior = entry.before?.value || "待补充";
  return `第 ${entry.version} 版 · ${task.fields[entry.field]} · ${fieldReviewNames[entry.action]} · ${prior} → ${entry.after.value}`;
}

function updateFieldReviews(record, task, resetAction) {
  const history = record.field_reviews || [];
  $("field-review-history").hidden = history.length === 0;
  $("field-review-entries").replaceChildren(...history.map((entry) => {
    const item = element("li", fieldReviewText(entry, task));
    if (entry.note) item.append(element("span", entry.note, "review-note-text"));
    for (const alert of entry.alerts || []) {
      const button = element("button", `第 ${alert.turn} 轮口述 ${alert.reported} 只 · 照片估计可见 ${alert.visible} 只`, "text-button");
      button.type = "button";
      button.addEventListener("click", () => selectField(entry.field, alert.turn));
      item.append(button);
    }
    return item;
  }));
  const form = $("field-review-form");
  form.hidden = record.status !== "pending";
  if (form.hidden) return;
  renderFieldReview(resetAction);
}

function renderFieldReview(resetAction = false) {
  const record = state.record;
  const field = record.fields[selectedField];
  $("field-review-heading").textContent = `复核${tasks[record.task].fields[selectedField]}`;
  const action = $("field-review-action");
  action.options[0].disabled = field?.status !== "recorded";
  if (resetAction || !action.value || (action.value === "confirm" && action.options[0].disabled)) {
    action.value = action.options[0].disabled ? "mark_unknown" : "confirm";
  }
  const correcting = action.value === "correct";
  $("field-review-value-panel").hidden = !correcting;
  $("field-review-value").required = correcting;
  $("field-review-note").required = correcting;
}

function addAction(label, action, className) {
  const button = element("button", label, className);
  button.type = "button";
  button.addEventListener("click", () => run(action));
  $("actions").append(button);
}

async function changeReview(action) {
  if (action === "submit" && hasTurnInput()) {
    throw new Error("本轮还有未保存的输入，请先处理或清空后再提交复核。");
  }
  if (hasFieldReviewInput()) {
    throw new Error("有尚未保存的字段判断，请先保存或清空。");
  }
  update(await request(`/api/records/${state.id}/review`, {
    action, version: state.record.version, status: state.record.status,
    note: action === "submit" ? "" : $("review-note").value,
  }));
  $("review-note").value = "";
  $("review-note-panel").open = false;
  if (action === "submit") selectQueue("pending", true);
  await refreshRecords();
  return `已${reviewNames[action]}。`;
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
      lines.push(`  - 第 ${evidence.turn} 轮${evidence.quote ? `原话「${markdownText(evidence.quote)}」` : "原图"}${evidence.superseded ? "（已被更正）" : ""}`);
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

function toggleNewRecord(open) {
  $("new-record").hidden = !open;
  $("toggle-new-record").setAttribute("aria-expanded", String(open));
  if (open) $("task").focus();
  else $("toggle-new-record").focus();
}

$("toggle-new-record").addEventListener("click", () => {
  if (!tasks) return;
  const leavingDatabase = !$("database-page").hidden;
  if (leavingDatabase) showDatabasePage(false);
  toggleNewRecord(leavingDatabase || $("new-record").hidden);
});
$("empty-new-record").addEventListener("click", () => {
  if (tasks) toggleNewRecord(true);
});
$("empty-record-list").addEventListener("click", () => {
  if (!tasks) return;
  selectQueue("", true);
  ($("record-list").querySelector("button") || $("record-search")).focus();
});
$("cancel-new-record").addEventListener("click", () => toggleNewRecord(false));
$("new-record").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!canLeaveInput()) return;
  run(async () => {
    update(await request("/api/records", {task: $("task").value}));
    toggleNewRecord(false);
    selectQueue("draft", true);
    await refreshRecords();
  });
});

async function finishTurn(data) {
  pendingTurn = undefined;
  $("turn").reset();
  $("rules-fallback").hidden = true;
  selectedTurn = data.record.turns.at(-1).id;
  update(data);
  const saved = `本轮已保存 · 第 ${data.record.version} 版`;
  setTurnFeedback(saved, "saved");
  await refreshRecords().catch(() => {});
}

$("turn").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!canWriteTurn() || !hasTurnInput() || pendingTurn) return;
  const rulesOnly = event.submitter === $("rules-fallback");
  run(async () => {
    const modeLabel = rulesOnly || mode !== "model" ? "正在用本地规则整理本轮…"
      : $("photo").files.length ? "正在用图文模型整理文字和照片…" : "正在用模型提取巡查字段…";
    setTurnFeedback(modeLabel);
    let payload;
    let data;
    try {
      payload = {
        message: $("message").value.trim(), image: await readImage($("photo").files[0]), version: state.record.version,
        status: state.record.status, rules_only: rulesOnly,
      };
      turnProcessing = rulesOnly || mode !== "model" ? "本地规则处理中…" : "模型提取中…";
      renderProgress(state, tasks[state.record.task]);
      data = await request(`/api/records/${state.id}/turn`, payload);
    } catch (error) {
      if (error.code === "model_unavailable") {
        $("rules-fallback").hidden = false;
        showModelStatus(true);
        setTurnFeedback(`${error.message} 本轮输入已保留，可重试模型或用规则保存。`, "error");
      } else if (error.code === "connection" || error.status === 409) {
        pendingTurn = {payload, length: state.record.turns.length, uncertain: error.code === "connection"};
        setTurnFeedback("本轮输入已保留。请先同步记录版本，核对保存状态。", "error");
      } else {
        setTurnFeedback(error.message, "error");
      }
      return;
    } finally {
      turnProcessing = "";
      renderProgress(state, tasks[state.record.task]);
    }
    if (!rulesOnly) showModelStatus();
    return finishTurn(data);
  });
});

for (const id of ["message", "photo"]) $(id).addEventListener("input", () => {
  if (!pendingTurn) setTurnFeedback(hasTurnInput() ? "本轮尚未保存。" : "");
  updateTurnButtons();
  if (!canWriteTurn() && !hasTurnInput()) $("turn").hidden = true;
});

$("sync-turn").addEventListener("click", () => run(async () => {
  try {
    const latest = await request(`/api/records/${state.id}`);
    const {payload, length, uncertain} = pendingTurn;
    const saved = latest.record.turns[length];
    if (uncertain && saved?.message === payload.message && (saved.image || "") === payload.image
        && $("message").value.trim() === payload.message && await readImage($("photo").files[0]) === payload.image) {
      return await finishTurn(latest);
    }
    // Retrying the same version is protected by the server's compare-and-save.
    pendingTurn = undefined;
    update(latest);
    if (canWriteTurn()) setTurnFeedback("已同步版本。本轮输入已保留，请核对记录后重试。");
    else setTurnFeedback("记录已进入复核。本轮输入仍在，可复制留存。", "error");
    await refreshRecords().catch(() => {});
  } catch (error) {
    setTurnFeedback(error.message, "error");
  }
}));

$("queue-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-status]");
  if (button && tasks) selectQueue(button.dataset.status);
});
for (const id of ["record-task", "record-date"]) $(id).addEventListener("change", () => tasks && renderList());
$("record-search").addEventListener("input", () => tasks && renderList());
$("refresh-records").addEventListener("click", () => {
  run(async () => {
    if (!tasks) return connectWorkbench();
    await refreshRecords();
    if (state && !hasUnsavedInput()) {
      const current = await request(`/api/records/${state.id}`);
      if (!hasUnsavedInput()) update(current);
    }
  });
});

$("open-connection").addEventListener("click", () => $("connection-dialog").showModal());
$("retry-connection").addEventListener("click", () => run(() => connectWorkbench(true)));
$("evidence-turn").addEventListener("change", () => {
  selectedTurn = Number($("evidence-turn").value);
  renderEvidence();
});
$("open-photo").addEventListener("click", () => {
  const photo = $("evidence-image");
  $("photo-title").textContent = photo.alt;
  $("photo-full").src = photo.src;
  $("photo-full").alt = photo.alt;
  $("photo-viewport").classList.remove("actual-size");
  $("photo-viewport").scrollTo(0, 0);
  $("photo-size").textContent = "原始尺寸";
  $("photo-dialog").showModal();
});
$("photo-size").addEventListener("click", () => {
  const actual = $("photo-viewport").classList.toggle("actual-size");
  $("photo-size").textContent = actual ? "适应窗口" : "原始尺寸";
  $("photo-viewport").scrollTo(0, 0);
});
$("photo-dialog").addEventListener("close", () => $("photo-full").removeAttribute("src"));
$("field-review-action").addEventListener("change", () => renderFieldReview());
$("field-review-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const data = await request(`/api/records/${state.id}/field-review`, {
      field: selectedField, action: $("field-review-action").value,
      value: $("field-review-value").value, note: $("field-review-note").value,
      version: state.record.version, status: state.record.status,
    });
    $("field-review-value").value = "";
    $("field-review-note").value = "";
    update(data);
    await refreshRecords();
    return `字段判断已保存至第 ${state.record.version} 版。`;
  });
});
$("close-preview").addEventListener("click", () => $("print-preview").close());
function clearKnowledgeResult() {
  $("knowledge-results").hidden = true;
  $("knowledge-citations").hidden = true;
  $("knowledge-result-mode").hidden = true;
  $("knowledge-answer").textContent = "";
  $("knowledge-sources").replaceChildren();
}

$("open-knowledge").addEventListener("click", () => {
  $("knowledge-context").hidden = true;
  $("knowledge-dialog").showModal();
});
$("knowledge-suggestions").addEventListener("click", (event) => {
  const suggestion = event.target.closest("button[data-question]");
  if (!suggestion || knowledgePending) return;
  $("knowledge-question").value = suggestion.dataset.question;
  clearKnowledgeResult();
  $("knowledge-question").focus();
});
$("field-knowledge").addEventListener("click", () => {
  if (knowledgePending) return;
  const record = state.record;
  const field = record.fields[selectedField];
  const label = tasks[record.task].fields[selectedField];
  let question = fieldQuestions[record.task];
  if (selectedField === "observation") {
    question = record.task === "trap" ? fieldQuestions.trapObservation : fieldQuestions.orchardObservation;
  }
  if (selectedField === "photo") question = fieldQuestions.photo;
  if (selectedField === "quantity") {
    if (state.evidence_alerts?.length) question = fieldQuestions.countConflict;
    else if (record.task === "trap" && field?.status === "unknown") question = fieldQuestions.unknown;
  }
  $("knowledge-context").hidden = false;
  $("knowledge-context").textContent = `当前字段 · ${label}。问题可编辑，点击「查询资料」后发送。`;
  $("knowledge-question").value = question;
  clearKnowledgeResult();
  $("knowledge-dialog").showModal();
});
$("knowledge-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || knowledgePending) return;
  knowledgePending = true;
  $("field-knowledge").disabled = true;
  const button = $("ask-knowledge");
  const input = $("knowledge-question");
  button.disabled = true;
  input.readOnly = true;
  clearKnowledgeResult();
  const answer = $("knowledge-answer");
  const resultMode = $("knowledge-result-mode");
  answer.className = "";
  answer.textContent = "正在查询资料…";
  $("knowledge-results").hidden = false;
  try {
    const result = await request("/api/knowledge/ask", {question: input.value});
    const count = result.retrieved_count ?? result.sources.length;
    const labels = {
      answered: ["模型带出处回答", result.model_name, `检索 ${count} 段`, `引用 ${result.sources.length} 段`],
      sources_only: ["资料摘要", `检索 ${count} 段`],
      no_match: ["未命中相关资料"],
    };
    resultMode.textContent = (labels[result.status] || []).filter(Boolean).join(" · ");
    resultMode.hidden = !resultMode.textContent;
    answer.textContent = result.answer;
    $("knowledge-citations").hidden = result.sources.length === 0;
    for (const source of result.sources) {
      const item = element("li");
      item.append(element("strong", source.source), element("p", source.section, "muted"), element("p", source.text));
      if (source.matched_terms?.length) item.append(element("p", `检索词 · ${source.matched_terms.join("、")}`, "muted"));
      if (source.url) {
        const link = element("a", "打开原文");
        link.href = `/api/knowledge/source?id=${encodeURIComponent(source.id)}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        item.append(link);
      }
      $("knowledge-sources").append(item);
    }
  } catch (error) {
    answer.textContent = error.message;
    answer.className = "error";
  } finally {
    knowledgePending = false;
    input.readOnly = false;
    button.disabled = busy;
    $("field-knowledge").disabled = busy;
  }
});
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

function editInspector(action, person) {
  const form = $("inspector-form");
  form.reset();
  inspectorEditor = action ? {action, person} : undefined;
  form.hidden = !action;
  if (!action) return;
  const title = {create: "新增巡查员", rename: "修改姓名", reset_password: "重置密码"}[action];
  $("inspector-editor-title").textContent = person ? `${title} · ${person.username}` : title;
  const fields = {username: action === "create", name: action !== "reset_password", password: action !== "rename"};
  for (const [key, show] of Object.entries(fields)) {
    $(`inspector-${key}-row`).hidden = !show;
    $(`inspector-${key}`).disabled = !show;
    $(`inspector-${key}`).required = show;
  }
  if (action === "rename") $("inspector-name").value = person.display_name;
  form.querySelector("input:not([disabled])").focus();
}

function renderInspectors(inspectors) {
  $("inspector-list").replaceChildren();
  if (!inspectors.length) $("inspector-list").append(element("li", "暂无巡查人员。"));
  for (const person of inspectors) {
    const row = element("li");
    const actions = element("div", undefined, "row");
    const available = [
      ["修改姓名", () => editInspector("rename", person)],
      ["重置密码", () => editInspector("reset_password", person)],
      [person.active ? "停用" : "启用", () => manageInspectors(`/api/inspectors/${person.id}`,
        {action: "active", active: !person.active}, person.active ? "已停用，原登录会话已失效。" : "已启用。")],
    ];
    for (const [label, handler] of available) {
      const button = element("button", label, "secondary compact");
      button.type = "button";
      button.addEventListener("click", handler);
      actions.append(button);
    }
    row.append(element("strong", `${person.display_name} · ${person.username}`),
      element("span", `${person.active ? "已启用" : "已停用"} · ${person.record_count} 条巡查记录`, "muted"), actions);
    $("inspector-list").append(row);
  }
}

async function manageInspectors(path, body, notice = "") {
  if (inspectorsBusy) return;
  inspectorsBusy = true;
  $("inspectors-status").textContent = body ? "正在保存…" : "正在读取巡查人员…";
  try {
    const data = await request(path, body);
    renderInspectors(data.inspectors);
    if (body) editInspector();
    $("inspectors-status").textContent = notice;
    if (body) refreshRecords({background: true});
  } catch (error) {
    $("inspectors-status").textContent = error.message;
  } finally {
    inspectorsBusy = false;
  }
}

$("open-inspectors").addEventListener("click", () => {
  $("inspectors-dialog").showModal();
  manageInspectors("/api/inspectors");
});
$("new-inspector").addEventListener("click", () => editInspector("create"));
$("cancel-inspector").addEventListener("click", () => editInspector());
$("inspectors-dialog").addEventListener("close", () => editInspector());
$("inspector-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!inspectorEditor) return;
  const {action, person} = inspectorEditor;
  const path = person ? `/api/inspectors/${person.id}` : "/api/inspectors";
  const values = {action};
  if (action === "create") values.username = $("inspector-username").value;
  if (action !== "reset_password") values.display_name = $("inspector-name").value;
  if (action !== "rename") values.password = $("inspector-password").value;
  manageInspectors(path, values, action === "reset_password" ? "密码已重置，原登录会话已失效。" : "已保存。");
});

async function connectWorkbench(checkDesktop = false) {
  showConnection("connecting", checkDesktop ? "正在检查巡查服务…" : "");
  try {
    if (checkDesktop && window.orchardDesktop?.reconnect) {
      const result = await window.orchardDesktop.reconnect();
      if (!result.ok) throw new Error(result.message);
    }
    const config = await request("/api/config");
    if (!tasks) {
      for (const [key, task] of Object.entries(config.tasks)) {
        $("task").add(new Option(task.label, key));
        $("record-task").add(new Option(task.label, key));
      }
    }
    tasks = config.tasks;
    mode = config.mode;
    modelName = config.model_name || "";
    $("open-inspectors").hidden = !config.account_mode || config.access !== "staff";
    $("open-database").hidden = !config.database_admin;
    if (!$("open-inspectors").hidden) $("record-search").placeholder = "点位、任务、编号或巡查员";
    showModelStatus();
    await refreshRecords();
    if (!state && !hasUnsavedInput()) {
      const previous = localStorage.getItem("orchard-last-record");
      const pending = records.filter((record) => record.status === "pending");
      const next = pending.find((record) => record.id === previous) || pending[0];
      if (next) update(await request(`/api/records/${next.id}`));
    }
    if (checkDesktop) $("connection-feedback").textContent = "巡查服务已重新连接。";
  } catch (error) {
    showConnection("offline", error.message);
    throw error;
  }
}

const sourceLabels = {local: "本地库", shared: "共享库"};
$("connection-target").textContent = sourceLabels[window.orchardDesktop?.connectionMode] || "浏览器连接";
$("connection-address").textContent = window.location.origin;
run(connectWorkbench);

setInterval(() => {
  if (tasks) refreshRecords({background: true});
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (tasks) refreshRecords({background: true});
});
