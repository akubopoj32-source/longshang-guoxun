const statusNames = { draft: "草稿", pending: "待复核", confirmed: "已复核", returned: "已退回" };
const fieldStates = { recorded: "已记录", unknown: "待核实", conflict: "待核对" };
const reviewNames = { submit: "提交复核", confirm: "确认记录", return: "退回补充" };
const fieldReviewNames = { confirm: "确认现值", correct: "人工更正", mark_unknown: "标记为待核实" };

function markdownText(value) {
  return String(value).replace(/\s+/g, " ").trim()
    .replace(/[&<>:\[\]()!*_\x60#~|\\]/g, (character) => `&#${character.charCodeAt(0)};`);
}

function charset() {
  const bytes = [0xef, 0xbb, 0xbf];
  return String.fromCharCode.apply(null, bytes);
}

function checklist(data, task) {
  const record = data.record;
  const fields = (task && task.fields) || {};
  const lines = ["# 果园巡查复查单", "", `记录编号 ${data.id}`,
    `任务 ${task ? task.label : record.task} · 第 ${record.version} 版 · ${statusNames[record.status]}`,
    "", "## 巡查记录", ""];
  for (const [key, label] of Object.entries(fields)) {
    const field = record.fields[key];
    lines.push(field
      ? `- **${label}** · ${markdownText(field.value)}（${fieldStates[field.status]}）`
      : `- **${label}** · 待补充`);
    for (const evidence of (field && field.evidence) || []) {
      lines.push(`  - 第 ${evidence.turn} 轮${evidence.quote ? `原话「${markdownText(evidence.quote)}」` : "原图"}${evidence.superseded ? "（已被更正）" : ""}`);
    }
  }
  lines.push("", "## 待核实事项", "",
    ...(data.pending.length ? data.pending.map((item) => `- ${markdownText(item)}`) : ["无"]));
  for (const alert of record.evidence_alerts || []) {
    lines.push(`- 第 ${alert.turn} 轮口述 ${alert.reported} 只，模型估计照片可见 ${alert.visible} 只。`);
  }
  if ((record.field_reviews || []).length) {
    lines.push("", "## 字段复核历史", "");
    for (const entry of record.field_reviews) {
      const prior = (entry.before && entry.before.value) || "待补充";
      lines.push(`- ${markdownText(`第 ${entry.version} 版 · ${fields[entry.field] || entry.field} · `
        + `${fieldReviewNames[entry.action] || entry.action} · ${prior} → ${entry.after.value}`)}`);
      if (entry.note) lines.push(`  - ${markdownText(entry.note)}`);
    }
  }
  lines.push("", "## 复核历史", "");
  for (const entry of record.reviews || []) {
    lines.push(`- 第 ${entry.version} 版 · ${reviewNames[entry.action] || entry.action} · ${entry.time}`);
    if (entry.note) lines.push(`  - ${markdownText(entry.note)}`);
  }
  if ((record.turns || []).some((turn) => turn.has_image || turn.image)) {
    lines.push("", "原图可在手机端证据区或工作台查看。");
  }
  return lines.join("\n") + "\n";
}

function jsonReport(data, task) {
  return JSON.stringify({
    kind: "orchard_inspection_record",
    exported_at: new Date().toISOString(),
    task_label: task ? task.label : data.record.task,
    record: data.record,
    evidence_alerts: data.evidence_alerts || [],
    pending: data.pending,
    questions: data.questions,
    id: data.id,
  }, null, 2) + "\n";
}

function fileName(id, version, extension) {
  return `巡查记录-${String(id).slice(0, 8)}-v${version}.${extension}`;
}

function writeFile(name, content) {
  const path = `${wx.env.USER_DATA_PATH}/${name}`;
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath: path,
      data: content,
      encoding: "utf8",
      success() { resolve(path); },
      fail() { reject(new Error("无法写入文件，请检查存储空间。")); },
    });
  });
}

/** Write the file then hand it to the share sheet; fall back to copy. */
async function shareFile(name, content) {
  const copyInstead = async () => {
    await copyText(content);
    return "当前环境无法发送文件，内容已复制到剪贴板，可粘贴保存。";
  };
  if (typeof wx.shareFileMessage !== "function") return copyInstead();
  const path = await writeFile(name, content);
  return new Promise((resolve, reject) => {
    wx.shareFileMessage({
      filePath: path,
      fileName: name,
      success() { resolve("已发送。"); },
      fail(detail) {
        const message = (detail && detail.errMsg) || "";
        if (/cancel/i.test(message)) {
          resolve("");
          return;
        }
        copyInstead().then(resolve, reject);
      },
    });
  });
}

async function copyText(content) {
  return new Promise((resolve, reject) => {
    wx.setClipboardData({
      data: content,
      success() { resolve("内容已复制到剪贴板。"); },
      fail() { reject(new Error("复制失败，请稍后重试。")); },
    });
  });
}

module.exports = { checklist, jsonReport, fileName, shareFile, copyText, markdownText, writeFile };
