const maxPhotoBytes = 4 * 1024 * 1024;

function choosePhoto() {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["camera", "album"],
      sizeType: ["compressed"],
      success(result) {
        const file = result.tempFiles[0];
        if (!file) return resolve("");
        if (file.size > maxPhotoBytes) return reject(new Error("压缩后的照片仍超过 4 MB，请选一张较小的照片。"));
        resolve(file.tempFilePath);
      },
      fail({ errMsg }) {
        if (errMsg?.includes("cancel")) return resolve("");
        reject(new Error("无法拍照或选择照片，请检查微信权限。"));
      },
    });
  });
}

function readPhoto(filePath) {
  if (!filePath) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success({ data }) {
        if (data.byteLength > maxPhotoBytes) return reject(new Error("照片不能超过 4 MB。"));
        const bytes = new Uint8Array(data, 0, Math.min(data.byteLength, 12));
        const matches = (signature, offset = 0) => signature.every((value, i) => bytes[offset + i] === value);
        let type;
        if (matches([0xff, 0xd8, 0xff])) type = "jpeg";
        else if (matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) type = "png";
        else if (matches([0x52, 0x49, 0x46, 0x46]) && matches([0x57, 0x45, 0x42, 0x50], 8)) type = "webp";
        if (!type) return reject(new Error("请选择 JPEG、PNG 或 WebP 照片。"));
        resolve(`data:image/${type};base64,${wx.arrayBufferToBase64(data)}`);
      },
      fail() { reject(new Error("无法读取照片，请重新选择。")); },
    });
  });
}

module.exports = { choosePhoto, readPhoto };
