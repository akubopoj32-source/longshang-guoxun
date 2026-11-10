const $ = (id) => document.getElementById(id);
const statusNames = {draft: "草稿", pending: "待复核", confirmed: "已复核", returned: "已退回"};
const fieldStates = {recorded: "已记录", unknown: "待核实", conflict: "待核对"};
let tasks;
let state;
let busy = false;

async function request(path, body) {
  const options = body === undefined ? {} : {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
  };
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败。");
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

async function run(action) {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  notify("正在处理…");
  try {
    await action();
    notify("");
  } catch (error) {
    notify(error.message, true);
  } finally {
    busy = false;
    for (const button of document.querySelectorAll("button")) button.disabled = false;
  }
}

function update(data) {
  state = data;
  localStorage.setItem("orchard-last-record", data.id);
  const record = data.record;
  const task = tasks[record.task];
  $("record-status").textContent = `${task.label} · 第 ${record.version} 版 · ${statusNames[record.status]}`;
  $("turn").hidden = !["draft", "returned"].includes(record.status);
  $("history").hidden = record.turns.length === 0;
  $("review").hidden = record.turns.length === 0;
  $("question").textContent = data.questions[0] || (record.turns.length ? "可以继续补充，或提交复核。" : "请描述现场观察。");
  $("fields").replaceChildren();
  for (const [key, label] of Object.entries(task.fields)) {
    const field = record.fields[key];
    const details = element("dd", field ? `${field.value} · ${fieldStates[field.status]}` : "待补充");
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
    entry.append(element("h3", `第 ${turn.id} 轮`), element("p", turn.message || "仅上传图片"));
    if (turn.image) {
      const image = element("img");
      image.src = turn.image;
      image.alt = `第 ${turn.id} 轮的巡查照片`;
      entry.append(image, element("p", turn.visual ? `模型视觉线索，待人工核对：${turn.visual}` : "已留存原图，当前无视觉提取结果。"));
    }
    $("turns").append(entry);
  }
  $("pending").replaceChildren(...(data.pending.length ? data.pending : ["无"]).map((item) => element("li", item)));
  $("revisions").replaceChildren(...record.revisions.filter((change) => change.before).map((change) =>
    element("li", `第 ${change.version} 版 · ${task.fields[change.field]}：${change.before.value} → ${change.after.value}`)));
  if (!$("revisions").children.length) $("revisions").append(element("li", "暂无字段修订。"));
  $("actions").replaceChildren();
  if (["draft", "returned"].includes(record.status)) addAction("提交复核", () => changeReview("submit"));
  if (record.status === "pending") addAction("确认当前版本", () => changeReview("confirm"));
  if (["pending", "confirmed"].includes(record.status)) addAction("退回补充", () => changeReview("return"));
  if (record.status === "confirmed") addAction("导出复核记录", exportRecord);
}

function addAction(label, action) {
  const button = element("button", label);
  button.type = "button";
  button.addEventListener("click", () => run(action));
  $("actions").append(button);
}

async function changeReview(action) {
  update(await request(`/api/records/${state.id}/review`, {
    action, version: state.record.version, status: state.record.status,
  }));
}

function exportRecord() {
  const data = {
    id: state.id, ...state.record, task_label: tasks[state.record.task].label, pending: state.pending,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: "application/json"}));
  const link = element("a");
  link.href = url;
  link.download = `巡查记录-${state.id.slice(0, 8)}-v${state.record.version}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  run(async () => {
    update(await request("/api/records", {task: $("task").value}));
    $("turn").reset();
  });
});

$("turn").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const image = await readImage($("photo").files[0]);
    update(await request(`/api/records/${state.id}/turn`, {
      message: $("message").value, image, version: state.record.version, status: state.record.status,
    }));
    $("turn").reset();
  });
});

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
  const previous = localStorage.getItem("orchard-last-record");
  if (previous) {
    try {
      update(await request(`/api/records/${encodeURIComponent(previous)}`));
      $("task").value = state.record.task;
    } catch {
      localStorage.removeItem("orchard-last-record");
    }
  }
});
