const { request } = require("./api");

const maxAudioBytes = 8 * 1024 * 1024;
const maxDuration = 120000;
let manager;
let activeRecording;

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
  if (manager || !wx.getRecorderManager) return manager;
  const instance = wx.getRecorderManager();
  if (!instance) return undefined;
  instance.onStop((result) => {
    const recording = activeRecording;
    activeRecording = undefined;
    if (!recording) return;
    if (!result?.tempFilePath) {
      recording.reject(new Error("录音失败，请重试。"));
    } else if (result.fileSize > maxAudioBytes) {
      recording.reject(new Error("录音超过 8 MB，请缩短时长。"));
    } else {
      recording.resolve({tempFilePath: result.tempFilePath, duration: result.duration || 0});
    }
  });
  instance.onError((error) => {
    const recording = activeRecording;
    activeRecording = undefined;
    const denied = /auth|permission|deny/i.test(error?.errMsg || "");
    recording?.reject(new Error(denied ? "没有麦克风权限，请在设置中允许录音。" : "录音失败，请重试。"));
  });
  manager = instance;
  return manager;
}

/** True when the platform can capture audio at all. */
function canRecord() {
  try {
    return Boolean(recorder());
  } catch {
    return false;
  }
}

function record() {
  return new Promise((resolve, reject) => {
    const instance = recorder();
    if (!instance) {
      reject(new Error("当前环境不支持录音。"));
      return;
    }
    if (activeRecording) {
      reject(new Error("上一段录音正在结束，请稍后重试。"));
      return;
    }
    activeRecording = {resolve, reject};
    try {
      instance.start({
        duration: maxDuration,
        format: "mp3",
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
      });
    } catch {
      activeRecording = undefined;
      reject(new Error("无法开始录音，请检查麦克风权限。"));
    }
  });
}

function stop() {
  try {
    if (activeRecording) manager.stop();
  } catch {
    const recording = activeRecording;
    activeRecording = undefined;
    recording?.reject(new Error("录音已中断，请重新录制。"));
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
