const databaseView = {
  page: 1,
  pages: 1,
  filters: { q: "", status: "" },
  backups: [],
  busy: false,
};

function showDatabasePage(open) {
  $("inspection-page").hidden = open;
  $("database-page").hidden = !open;
  $("open-database").setAttribute("aria-pressed", String(open));
  if (open) $("open-inspection").removeAttribute("aria-current");
  else $("open-inspection").setAttribute("aria-current", "page");
}

function updateDatabaseControls() {
  for (const control of $("database-page").querySelectorAll("button, input, select")) {
    control.disabled = databaseView.busy;
  }
  $("database-previous").disabled = databaseView.busy || databaseView.page <= 1;
  $("database-next").disabled = databaseView.busy || databaseView.page >= databaseView.pages;
}

function databaseFeedback(message, error = false) {
  $("database-feedback").textContent = message;
  $("database-feedback").classList.toggle("error", error);
}

async function runDatabaseAction(action, pending) {
  if (databaseView.busy) return;
  databaseView.busy = true;
  updateDatabaseControls();
  databaseFeedback(pending);
  try {
    const message = await action();
    databaseFeedback(message || "");
  } catch (error) {
    databaseFeedback(error.message, true);
  } finally {
    databaseView.busy = false;
    updateDatabaseControls();
  }
}

function formatBackupSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function renderDatabaseBackups(backups) {
  databaseView.backups = backups;
  $("database-backup-empty").hidden = backups.length > 0;
  $("database-backups").replaceChildren(...backups.map((backup) => {
    const item = element("li");
    item.append(element("strong", backup.name), element("span",
      activityFormat.format(new Date(backup.created_at)) + " · " + formatBackupSize(backup.bytes), "muted"));
    return item;
  }));
}

function openDatabaseRecord(id) {
  if (databaseView.busy || !canLeaveInput()) return;
  runDatabaseAction(async () => {
    const data = await request("/api/records/" + encodeURIComponent(id));
    showDatabasePage(false);
    update(data);
    selectQueue(data.record.status, true);
    $("record-title").focus({preventScroll: true});
  }, "正在打开巡查记录…");
}

function renderDatabaseRecords(records) {
  const rows = records.map((record) => {
    const row = element("tr");
    const identity = element("td");
    const shortId = element("span", "#" + record.id.slice(0, 8), "muted");
    shortId.title = record.id;
    identity.append(element("strong", record.location || "点位待补充"), shortId,
      element("span", tasks?.[record.task]?.label || "巡查记录", "muted"));
    const inspector = element("td", record.inspector_name || "工作台记录");
    if (record.inspector_username) inspector.append(element("span", record.inspector_username, "muted"));
    const status = element("td");
    status.append(statusBadge(record.status));
    const activity = element("td", record.activity_at ? activityFormat.format(new Date(record.activity_at)) : "—", "muted");
    const action = element("td");
    const button = element("button", "查看记录", "secondary compact");
    button.type = "button";
    button.setAttribute("aria-label", "查看记录 #" + record.id.slice(0, 8));
    button.addEventListener("click", () => openDatabaseRecord(record.id));
    action.append(button);
    row.append(identity, inspector, status, activity, action);
    return row;
  });
  $("database-rows").replaceChildren(...rows);
  $("database-empty").hidden = rows.length > 0;
}

async function loadDatabaseOverview(page, filters = databaseView.filters) {
  const query = new URLSearchParams({...filters, page});
  const data = await request("/api/database?" + query);
  const {database, counts} = data;
  Object.assign(databaseView, { page: data.page, pages: data.pages, filters });
  $("database-engine").textContent = "SQLite · 架构版本 " + database.schema_version + " · " + database.journal_mode.toUpperCase();
  $("database-count").textContent = counts.records;
  $("database-pending").textContent = counts.by_status.pending;
  $("database-confirmed").textContent = counts.by_status.confirmed;
  $("database-inspectors").textContent = counts.inspectors;
  $("database-file").textContent = database.path;
  $("database-backup-folder").textContent = data.backup_path;
  $("database-pagination-label").textContent = "共 " + data.total + " 条 · 第 " + data.page + "/" + data.pages + " 页";
  renderDatabaseRecords(data.records);
  renderDatabaseBackups(data.backups);
}

$("open-database").addEventListener("click", () => {
  showDatabasePage($("database-page").hidden);
  if ($("database-page").hidden) return;
  $("database-title").focus();
  runDatabaseAction(() => loadDatabaseOverview(databaseView.page), "正在读取数据库…");
});
$("back-to-workbench").addEventListener("click", () => {
  showDatabasePage(false);
  $("open-inspection").focus();
});
$("open-inspection").addEventListener("click", () => showDatabasePage(false));
$("refresh-database").addEventListener("click", () =>
  runDatabaseAction(() => loadDatabaseOverview(databaseView.page), "正在刷新数据库…"));
$("database-filters").addEventListener("submit", (event) => {
  event.preventDefault();
  const filters = {q: $("database-query").value.trim(), status: $("database-status").value};
  runDatabaseAction(() => loadDatabaseOverview(1, filters), "正在查询巡查记录…");
});
$("database-previous").addEventListener("click", () => {
  if (databaseView.page > 1) runDatabaseAction(() => loadDatabaseOverview(databaseView.page - 1), "正在读取记录…");
});
$("database-next").addEventListener("click", () => {
  if (databaseView.page < databaseView.pages) runDatabaseAction(() => loadDatabaseOverview(databaseView.page + 1), "正在读取记录…");
});
$("database-check").addEventListener("click", () => runDatabaseAction(async () => {
  const output = $("database-check-result");
  output.textContent = "";
  const result = await request("/api/database/check", {});
  output.textContent = result.message;
  output.classList.toggle("error", result.status !== "ok");
}, "正在校验数据库…"));
$("database-backup").addEventListener("click", () => runDatabaseAction(async () => {
  const data = await request("/api/database/backup", {});
  renderDatabaseBackups([data.backup, ...databaseView.backups].slice(0, 10));
  return "备份已创建并校验通过。";
}, "正在创建数据库备份…"));
