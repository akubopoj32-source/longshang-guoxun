const statusNames = { draft: "草稿", pending: "待复核", confirmed: "已复核", returned: "已退回" };
const fieldStates = { recorded: "已记录", unknown: "待核实", conflict: "待核对" };
const reviewNames = { submit: "提交复核", confirm: "确认记录", return: "退回补充" };
const fieldReviewNames = { confirm: "确认现值", correct: "人工更正", mark_unknown: "标记为待核实" };
const modeNames = { model: "图文模型", rules: "本地规则" };
const qualityNames = { usable: "可复查", limited: "细节或范围有限", unassessed: "未评估" };

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Turn a record into view models the WXML can render directly. */
function presentRecord(record, task) {
  const labels = (task && task.fields) || {};
  const corrected = new Set((record.revisions || [])
    .filter((change) => change.before && change.before.value !== change.after.value)
    .map((change) => change.field));
  const fields = Object.entries(labels).map(([key, label]) => {
    const field = record.fields[key];
    const sources = (field && field.evidence) || [];
    return {
      key,
      label,
      value: (field && field.value) || "待补充",
      state: (field && fieldStates[field.status]) || "",
      status: (field && field.status) || "missing",
      reviewed: Boolean(field && field.review_version),
      reviewedAt: field && field.review_version ? `第 ${field.review_version} 版人工判断` : "",
      corrected: corrected.has(key) && Boolean(field),
      evidence: sources.map((source, index) => ({
        turn: source.turn,
        // Evidence is newest-first; anything after the first entry predates a
        // correction, so the reader can tell the superseded statement apart.
        superseded: corrected.has(key) && index > 0 && Boolean(source.quote),
        text: source.quote ? `第 ${source.turn} 轮 · ${source.quote}` : `第 ${source.turn} 轮 · 原图`,
      })),
    };
  });

  const turns = (record.turns || []).map((turn) => ({
    id: turn.id,
    anchor: `evidence-${turn.id}`,
    heading: `第 ${turn.id} 轮${modeNames[turn.extraction_mode] ? ` · ${modeNames[turn.extraction_mode]}` : ""}`,
    message: turn.message || "",
    messageText: turn.message ? `巡查员原话：${turn.message}` : "仅上传图片",
    image: turn.image || "",
    visual: turn.visual || "",
    visualText: turn.visual ? `模型视觉线索，待人工核对：${turn.visual}` : "",
    quality: turn.photo_quality || "unassessed",
    qualityText: turn.photo_quality && turn.photo_quality !== "unassessed"
      ? `照片质量：${qualityNames[turn.photo_quality] || turn.photo_quality}` : "",
    visibleText: turn.visible_count != null
      ? `模型估计照片中可见 ${turn.visible_count} 只，待人工核对。` : "",
    time: formatTime(turn.time),
  }));

  const alerts = (record.evidence_alerts || []).map((alert) => ({
    turn: alert.turn,
    anchor: `evidence-${alert.turn}`,
    text: `口述 ${alert.reported} 只，照片估计可见 ${alert.visible} 只。`,
    linkText: `查看第 ${alert.turn} 轮原话与照片`,
  }));

  const revisions = (record.revisions || [])
    .filter((change) => change.before && change.before.value !== change.after.value)
    .map((change) => ({
      key: `${change.version}-${change.field}`,
      text: `第 ${change.version} 版 · ${labels[change.field] || change.field}：`
        + `${change.before.value} → ${change.after.value}`,
    }));

  const reviews = (record.reviews || []).map((entry, index) => ({
    key: `review-${index}-${entry.version}`,
    text: `第 ${entry.version} 版 · ${reviewNames[entry.action] || entry.action} · ${formatTime(entry.time)}`,
    note: entry.note || "",
  }));

  const fieldReviews = (record.field_reviews || []).map((entry, index) => ({
    key: `field-review-${index}-${entry.version}`,
    text: `第 ${entry.version} 版 · ${labels[entry.field] || entry.field} · `
      + `${fieldReviewNames[entry.action] || entry.action} · `
      + `${(entry.before && entry.before.value) || "待补充"} → ${entry.after.value}`,
    note: entry.note || "",
    alerts: (entry.alerts || []).map((alert) => ({
      turn: alert.turn,
      anchor: `evidence-${alert.turn}`,
      text: `第 ${alert.turn} 轮口述 ${alert.reported} 只 · 照片估计可见 ${alert.visible} 只`,
    })),
  }));

  return { fields, turns, alerts, revisions, reviews, fieldReviews };
}

module.exports = { formatTime, presentRecord, statusNames, fieldStates, reviewNames, fieldReviewNames };