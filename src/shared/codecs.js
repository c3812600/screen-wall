'use strict';

/**
 * 流媒体与 codec 工具：主进程 require 与渲染进程 <script> 共用。
 * 纯 JS 实现，不依赖 Node API，两侧行为一致。
 */

/** 流地址识别（rtsp 等，浏览器内核无法直接播放，需走拉流引擎） */
function isStreamUrl(src) {
  return /^(rtsp|rtsps|rtmp|rtmps):\/\//i.test(String(src || '').trim());
}

/**
 * 从 fMP4 初始化段中解析 H.264 codec 字符串。
 * 找到 avcC box，取 profile/compat/level 三字节 → avc1.PPCCLL；非 H.264 返回 null。
 */
function parseAvcCodec(data) {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data || []);
  for (let i = 0; i + 7 < b.length; i++) {
    if (b[i] === 0x61 && b[i + 1] === 0x76 && b[i + 2] === 0x63 && b[i + 3] === 0x43) {
      const hex = (n) => n.toString(16).padStart(2, '0');
      return `avc1.${hex(b[i + 5])}${hex(b[i + 6])}${hex(b[i + 7])}`;
    }
  }
  return null;
}

const StreamCodecApi = { isStreamUrl, parseAvcCodec };
if (typeof module !== 'undefined' && module.exports) module.exports = StreamCodecApi;
if (typeof window !== 'undefined') window.StreamCodec = StreamCodecApi;
