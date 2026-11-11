'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { isStreamUrl, parseAvcCodec } = require('./shared/codecs');

function findFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (process.resourcesPath) {
    const packed = path.join(process.resourcesPath, exe);
    if (fs.existsSync(packed)) return packed;
  }
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* 回退 PATH */
  }
  return exe;
}

// 无声：监控流音轨多为 MSE 不支持的编码，直接丢弃
const COPY_ARGS = ['-an', '-c:v', 'copy'];
const TRANSCODE_ARGS = [
  '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
  '-bf', '0', '-g', '30', '-pix_fmt', 'yuv420p',
];

const HEAD_LIMIT = 2 * 1024 * 1024;

/**
 * 流引擎：ffmpeg 把 rtsp 等转封装为 fMP4（不转码），
 * 通过本机 HTTP 以分块方式分发给渲染进程的 MediaSource。
 * - 同一 source 单实例共享（编辑器/播放器可同时订阅）
 * - 非 H.264 自动降级为转码模式（libx264）
 * - 断流按指数退避自动重连
 */
class StreamService {
  constructor() {
    this.streams = new Map();
    this.server = null;
    this.port = 0;
    this.ready = null;
    this.ffmpeg = findFfmpeg();
  }

  /** 启动本地 HTTP 分发服务；返回在端口就绪后 resolve 的 Promise */
  start() {
    if (this.ready) return this.ready;
    this.server = http.createServer((req, res) => this._onRequest(req, res));
    this.ready = new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this.ready;
  }

  hashOf(source) {
    return crypto.createHash('sha1').update(String(source)).digest('hex').slice(0, 12);
  }

  /** 确保流在拉取中，返回本地 HTTP 地址（渲染端 fetch 消费）；端口就绪后才返回 */
  async open(source) {
    if (!isStreamUrl(source)) return null;
    await this.start();
    const key = this.hashOf(source);
    let st = this.streams.get(key);
    if (!st) {
      st = {
        key,
        source: String(source).trim(),
        proc: null,
        head: [],
        headLen: 0,
        codecChecked: false,
        clients: new Set(),
        restarts: 0,
        transcode: false,
        timer: null,
      };
      this.streams.set(key, st);
      this._spawn(st);
    } else if (!st.proc && !st.timer) {
      st.restarts = 0;
      this._spawn(st);
    }
    return { url: `http://127.0.0.1:${this.port}/s/${key}` };
  }

  _spawn(st) {
    // 新一代拉流清掉上一代缓冲：避免迟到客户端回放到混合两次会话的 init/分片
    st.head = [];
    st.headLen = 0;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (/^rtsp/i.test(st.source)) args.push('-rtsp_transport', 'tcp');
    args.push('-i', st.source);
    args.push(...(st.transcode ? TRANSCODE_ARGS : COPY_ARGS));
    args.push(
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-flush_packets', '1',
      'pipe:1',
    );

    let proc;
    try {
      proc = spawn(this.ffmpeg, args, { windowsHide: true });
    } catch {
      this._scheduleRestart(st);
      return;
    }
    st.proc = proc;

    proc.stdout.on('data', (chunk) => {
      // 累积头部直到能判断编码：H.264 直接播；其他降级转码后重启
      if (!st.codecChecked) {
        st.head.push(chunk);
        st.headLen += chunk.length;
        const joined = Buffer.concat(st.head);
        const codec = parseAvcCodec(joined);
        if (codec) {
          st.codecChecked = true;
          st.head = [joined];
        } else if (st.headLen > 512 * 1024) {
          st.codecChecked = true;
          if (!st.transcode) {
            st.transcode = true;
            st.head = [];
            st.headLen = 0;
            this._kill(st);
            this._scheduleRestart(st, 400);
            return;
          }
        }
        for (const res of st.clients) {
          try { res.write(chunk); } catch { /* 客户端已断开 */ }
        }
        return;
      }

      if (st.headLen < HEAD_LIMIT) {
        st.head.push(chunk);
        st.headLen += chunk.length;
      }
      for (const res of st.clients) {
        try { res.write(chunk); } catch { /* 客户端已断开 */ }
      }
    });

    proc.stderr.on('data', () => { /* 忽略 ffmpeg 日志 */ });

    proc.on('exit', () => {
      if (st.proc === proc) st.proc = null;
      for (const res of st.clients) {
        try { res.end(); } catch { /* 忽略 */ }
      }
      st.clients.clear();
      // 本代缓冲作废：重连后的新客户端只接新会话数据，不回放旧 init/分片
      st.head = [];
      st.headLen = 0;
      this._scheduleRestart(st);
    });
  }

  _kill(st) {
    try {
      if (st.proc) st.proc.kill();
    } catch { /* 忽略 */ }
    st.proc = null;
  }

  _scheduleRestart(st, delay) {
    if (st.timer) return;
    st.restarts += 1;
    // 不放弃重连：退避封顶 30s，断流自愈（摄像头重启/网络抖动后自动跟上）
    const wait = delay || Math.min(30000, 1000 * Math.pow(2, Math.min(st.restarts, 5)));
    st.timer = setTimeout(() => {
      st.timer = null;
      this._spawn(st);
    }, wait);
  }

  _onRequest(req, res) {
    const m = /^\/s\/([a-f0-9]+)(?:$|[?/])/.exec(req.url || '');
    const st = m ? this.streams.get(m[1]) : null;
    if (!st) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'keep-alive',
    });
    // 先把响应头推给客户端：空头缓冲时 fetch 也能立刻返回，不等首字节
    res.flushHeaders();
    // 先回放已缓冲头部（初始化段 + 最近数据），再接实时流
    for (const c of st.head) {
      try { res.write(c); } catch { /* 忽略 */ }
    }
    st.clients.add(res);
    req.on('close', () => st.clients.delete(res));
  }
}

module.exports = StreamService;
