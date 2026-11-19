const { connection } = require("./api");
const { readPhoto } = require("./photo");

const identifier = /^[a-f0-9]{32}$/;

function newSubmissionId() {
  // This ID deduplicates writes within a record. It is never used for authentication.
  const hexWord = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return Date.now().toString(16).padStart(12, "0") + (hexWord() + hexWord() + hexWord()).slice(0, 20);
}

function draftKey(id) {
  const { origin, auth, username } = connection();
  const owner = auth === "account" ? ["account", username] : ["legacy"];
  return `orchard-draft:${JSON.stringify([origin, ...owner, id])}`;
}

function loadDraft(key) {
  const saved = wx.getStorageSync(key);
  if (!saved || typeof saved !== "object") return { message: "", photo: "", submission: null };
  const attempt = saved.submission;
  const submission = attempt && identifier.test(attempt.id) && Number.isInteger(attempt.version)
    && ["draft", "returned"].includes(attempt.status) && typeof attempt.rulesOnly === "boolean" ? attempt : null;
  return {
    message: typeof saved.message === "string" ? saved.message.slice(0, 2000) : "",
    photo: isDraftPhoto(saved.photo) ? saved.photo : "",
    submission,
  };
}

function storeDraft(key, draft) {
  try {
    if (draft.message || draft.photo || draft.submission) wx.setStorageSync(key, draft);
    else wx.removeStorageSync(key);
  } catch {
    throw new Error("无法更新本机草稿，请检查微信存储空间。");
  }
}

function photoFolder() {
  return `${wx.env.USER_DATA_PATH}/orchard-draft-`;
}

function isDraftPhoto(path) {
  return typeof path === "string" && path !== "" && path.startsWith(photoFolder())
    && /^[a-f0-9]{32}\.(jpeg|png|webp)$/.test(path.slice(photoFolder().length));
}

async function retainDraftPhoto(tempFilePath) {
  const encoded = await readPhoto(tempFilePath);
  const [header, data] = encoded.split(",", 2);
  const type = header.slice("data:image/".length, -";base64".length);
  const filePath = `${photoFolder()}${newSubmissionId()}.${type}`;
  await new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath, data, encoding: "base64",
      success: resolve,
      fail: () => reject(new Error("照片无法保存到本机，请检查微信存储空间。")),
    });
  });
  return filePath;
}

function removeDraftPhoto(path) {
  if (isDraftPhoto(path)) wx.getFileSystemManager().unlink({ filePath: path, fail() {} });
}

function hasLocalDraft(id) {
  try {
    const draft = loadDraft(draftKey(id));
    return Boolean(draft.message || draft.photo);
  } catch {
    return false;
  }
}

module.exports = { draftKey, loadDraft, storeDraft, newSubmissionId, retainDraftPhoto, removeDraftPhoto, hasLocalDraft };
