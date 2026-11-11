'use strict';

const stage = document.getElementById('stage');
const hint = document.getElementById('hint');

let project = null;

/** 把配置里的 source（绝对路径或 URL）转成渲染器可用的 URL */
function toDisplayUrl(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s; // 任意协议（http/file/rtsp…）原样放行
  let p = s.replace(/\\/g, '/');
  if (!/^\//.test(p)) p = '/' + p;
  return encodeURI('file://' + p);
}

function transformOf(c) {
  const sx = c.mirrorX ? -1 : 1;
  const sy = c.mirrorY ? -1 : 1;
  return `rotate(${Number(c.rotation) || 0}deg) scaleX(${sx}) scaleY(${sy})`;
}

/** 网页内容缩放：iframe 布局放大 1/z 倍再视觉缩回 z 倍，等效页面缩放 */
function applyWebZoom(frame, c) {
  const z = Math.max(0.25, Math.min(4, Number(c.web?.zoom) || 1));
  frame.style.width = (100 / z) + '%';
  frame.style.height = (100 / z) + '%';
  frame.style.transformOrigin = 'top left';
  frame.style.transform = `scale(${z})`;
}

/** 填充模式：contain 保持比例 / fill 拉伸 / cover 裁剪（默认） */
function fitOf(c) {
  return ['contain', 'fill', 'cover'].includes(c.fit) ? c.fit : 'cover';
}

function buildComponent(c) {
  const el = document.createElement('div');
  el.className = 'comp';
  el.style.left = (Number(c.x) || 0) + 'px';
  el.style.top = (Number(c.y) || 0) + 'px';
  el.style.width = Math.max(1, Number(c.width) || 1) + 'px';
  el.style.height = Math.max(1, Number(c.height) || 1) + 'px';
  el.style.zIndex = String(Number(c.zIndex) || 0);
  el.style.transform = transformOf(c);

  const url = toDisplayUrl(c.source);
  let media;
  if (c.type === 'video') {
    media = document.createElement('video');
    media.autoplay = true;
    media.loop = true;
    media.playsInline = true;
    media.preload = 'auto';
    const video = c.video || {};
    media.muted = video.muted !== false;
    media.volume = Math.max(0, Math.min(1, Number(video.volume) || 0));
    media.style.objectFit = fitOf(c);
    if (window.StreamVideo && window.StreamVideo.isStreamUrl(c.source)) {
      media.dataset.stream = '1';
      window.StreamVideo.attach(media, c.source);
    } else {
      media.src = url;
      media.addEventListener('canplay', () => {
        media.play().catch(() => {});
      });
    }
  } else if (c.type === 'image') {
    media = document.createElement('img');
    media.src = url;
    media.draggable = false;
    media.style.objectFit = fitOf(c);
  } else if (c.type === 'website') {
    media = document.createElement('iframe');
    media.src = url;
    media.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    media.setAttribute('scrolling', 'no');
    applyWebZoom(media, c);
  } else {
    return null;
  }
  el.appendChild(media);
  return el;
}

function fitStage() {
  if (!project) return;
  const cw = project.canvas.width;
  const ch = project.canvas.height;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  stage.style.width = cw + 'px';
  stage.style.height = ch + 'px';

  // 自动模式（画布即全部显示器联合区域）：始终按窗口精确铺满，1:1 映射
  // 窗口尺寸与画布接近（已按显示器区域铺满）同理：精确填满，消除居中留白偏移
  const isAuto = !!project.canvas.auto;
  const nearW = Math.abs(vw - cw) <= Math.max(8, Math.round(cw * 0.02));
  const nearH = Math.abs(vh - ch) <= Math.max(8, Math.round(ch * 0.02));
  if (isAuto || (nearW && nearH)) {
    stage.style.transform = `translate(0px, 0px) scale(${vw / cw}, ${vh / ch})`;
    return;
  }

  // 回退：单屏等比缩放（保持画面比例）
  const s = Math.min(vw / cw, vh / ch);
  const ox = (vw - cw * s) / 2;
  const oy = (vh - ch * s) / 2;
  stage.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
}

function render(next) {
  project = next;
  stage.innerHTML = '';
  if (!project || !project.canvas) {
    hint.textContent = '未配置项目 — 右键托盘图标选择「编辑」创建项目';
    hint.style.display = 'block';
    return;
  }
  hint.style.display = 'none';
  const components = Array.isArray(project.components) ? project.components : [];
  components
    .slice()
    .sort((a, b) => (Number(a.zIndex) || 0) - (Number(b.zIndex) || 0))
    .forEach((c) => {
      const el = buildComponent(c);
      if (el) stage.appendChild(el);
    });
  fitStage();
  updatePlacementHint();
}

/** 画布未匹配到显示器区域时给出诊断提示，便于排查排列/缩放设置 */
async function updatePlacementHint() {
  if (project.canvas.auto) return; // 自动模式恒铺满联合区域，无需匹配
  try {
    const matched = await window.api.matchDisplayRegion(project.canvas);
    if (matched) return;
    const regions = await window.api.listDisplayRegions();
    const names = regions.map((r) => r.label).join('、') || '未检测到显示器';
    hint.textContent = `画布 ${project.canvas.width}×${project.canvas.height} 未匹配显示器区域（检测到：${names}），当前按单屏缩放显示`;
    hint.style.display = 'block';
  } catch {
    /* 忽略诊断失败 */
  }
}

window.addEventListener('resize', fitStage);

window.api.getActiveProject().then(render);
window.api.onProjectChanged(render);
