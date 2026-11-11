'use strict';

/**
 * 流媒体视频（rtsp 等）渲染：主进程 ffmpeg 转封装 fMP4 → 本机 HTTP → MediaSource。
 * 依赖 window.StreamCodec（codecs.js）与 window.api.openStream。
 */
(function () {
  const Codec = window.StreamCodec || {};

  function concatChunks(chunks, total) {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /** SourceBuffer 串行追加队列（appendBuffer 不允许并发） */
  function makeAppender(sb) {
    const queue = [];
    let updating = false;
    const pump = () => {
      if (updating || !queue.length) return;
      updating = true;
      try {
        sb.appendBuffer(queue.shift());
      } catch {
        updating = false;
        return;
      }
      sb.addEventListener('updateend', () => {
        updating = false;
        pump();
      }, { once: true });
    };
    return (chunk) => {
      queue.push(chunk);
      pump();
    };
  }

  async function consumeOnce(video, url) {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error('stream http ' + res.status);
    const reader = res.body.getReader();

    const ms = new MediaSource();
    video.src = URL.createObjectURL(ms);
    await new Promise((resolve) => ms.addEventListener('sourceopen', resolve, { once: true }));

    let sb = null;
    let append = null;
    let head = [];
    let headLen = 0;

    for (;;) {
      if (!video.isConnected) {
        try { reader.cancel(); } catch { /* 忽略 */ }
        try { if (ms.readyState === 'open') ms.endOfStream(); } catch { /* 忽略 */ }
        return 'detached';
      }
      const { done, value } = await reader.read();
      if (done) break;

      if (!sb) {
        head.push(value);
        headLen += value.length;
        const joined = concatChunks(head, headLen);
        const codec = Codec.parseAvcCodec(joined);
        const mime = codec ? `video/mp4; codecs="${codec}"` : null;
        if (mime && MediaSource.isTypeSupported(mime)) {
          sb = ms.addSourceBuffer(mime);
          append = makeAppender(sb);
          for (const c of head) append(c);
          head = [];
        } else if (headLen > 512 * 1024) {
          // 服务端将降级转码，重连后可播
          try { reader.cancel(); } catch { /* 忽略 */ }
          return 'retry';
        }
        continue;
      }
      append(value);
    }

    try {
      if (ms.readyState === 'open') ms.endOfStream();
    } catch { /* 忽略 */ }
    return 'ended';
  }

  /** 给 <video> 挂流：内部自动重连（断流恢复），元素脱离文档后停止 */
  async function attach(video, source) {
    if (!Codec.isStreamUrl(source)) return;
    video.dataset.stream = '1';
    try {
      const info = await window.api.openStream(source);
      if (!info || !info.url) return;
      for (let attempt = 0; attempt < 200; attempt++) {
        if (!video.isConnected && attempt > 0) return;
        try {
          const state = await consumeOnce(video, info.url);
          if (state === 'detached') return;
          video.play().catch(() => {});
        } catch {
          /* 落到重试 */
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (e) {
      console.error('stream attach failed', e);
    }
  }

  window.StreamVideo = {
    attach,
    isStreamUrl: (s) => Codec.isStreamUrl(s),
  };
})();
