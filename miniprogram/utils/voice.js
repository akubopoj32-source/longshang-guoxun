const { request } = require("./api");

const maxAudioBytes = 8 * 1024 * 1024;
const maxDuration = 120000;

const mimeByExtension = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
  ogg: "audio/ogg",
  webm: "audio/webm",
  amr: "audio/amr",
  "3gp": "audio/3gpp",
};

function recorder() {
  return wx.getRecorderManager();
}

/** True when the platform can capture audio at all. */
function canRecord() {
  try {
    return Boolean(wx.getRecorderManager && wx.getRecorderManager());
  } catch {
    return false;
  }
}

/**
 * Record one clip. Resolves with { tempFilePath, duration, size } or "" when
 * the user aborts. The recorder manager is a singleton, so listeners are
 * replaced on every call to avoid stacking handlers.
 */
function record() {
  return new Promise((resolve, reject) => {
    const manager = recorder();
    if (!manager) {
      reject(new Error("当前环境不支持录音。"));
      return;
    }
    let result = null;
    manager.onStart(() => {});
    manager.onStop((res) => {
      if (!res || !res.tempFilePath) {
        reject(new Error("录音失败，请重试。"));
        return;
      }
      if (res.fileSize > maxAudioBytes) {
        reject(new Error("录音超过 8 MB，请缩短时长。"));
        return;
      }
      resolve({
        tempFilePath: res.tempFilePath,
        duration: res.duration || 0,
        size: res.fileSize || 0,
      });
    });
    manager.onError((error) => {
      const message = (error && error.errMsg) || "";
      reject(new Error(/auth|permission|deny/i.test(message)
        ? "没有麦克风权限，请在设置中允许录音。"
        : "录音失败，请重试。"));
    });
    manager.start({
      duration: maxDuration,
      format: "mp3",
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
    });
    // Swallow the unused binding so linters do not flag it.
    void result;
  });
}

function stop() {
  try {
    recorder().stop();
  } catch {
    /* recorder may not be active */
  }
}

function readAudio(filePath) {
  if (!filePath) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success({ data }) {
        if (data.byteLength > maxAudioBytes) {
          reject(new Error("录音超过 8 MB，请缩短时长。"));
          return;
        }
        const extension = String(filePath).split(".").pop().toLowerCase();
        const mime = mimeByExtension[extension] || "audio/mpeg";
        resolve(`data:${mime};base64,${wx.arrayBufferToBase64(data)}`);
      },
      fail() { reject(new Error("无法读取录音，请重新录制。")); },
    });
  });
}

/** Send a recording to the workbench and return the transcript. */
async function transcribe(filePath, hint = "") {
  const audio = await readAudio(filePath);
  if (!audio) throw new Error("请先录音。");
  const result = await request("/api/transcribe", { audio, hint });
  return result.transcript || "";
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

module.exports = { canRecord, record, stop, readAudio, transcribe, formatDuration, maxDuration };