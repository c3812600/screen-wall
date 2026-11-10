'use strict';

const stage = document.getElementById('stage');
const hint = document.getElementById('hint');

let project = null;

/** 把配置里的 source（绝对路径或 URL）转成渲染器可用的 URL */
function toDisplayUrl(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  if (/^(https?:|file:|data:|about:)/i.test(s)) return s;
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
    media.src = url;
    media.autoplay = true;
    media.loop = true;
    media.playsInline = true;
    media.preload = 'auto';
    const video = c.video || {};
    media.muted = video.muted !== false;
    media.volume = Math.max(0, Math.min(1, Number(video.volume) || 0));
    media.addEventListener('canplay', () => {
      media.play().catch(() => {});
    });
  } else if (c.type === 'image') {
    media = document.createElement('img');
    media.src = url;
    media.draggable = false;
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
  const s = Math.min(window.innerWidth / cw, window.innerHeight / ch);
  const ox = (window.innerWidth - cw * s) / 2;
  const oy = (window.innerHeight - ch * s) / 2;
  stage.style.width = cw + 'px';
  stage.style.height = ch + 'px';
  stage.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
}

function render(next) {
  project = next;
  stage.innerHTML = '';
  if (!project || !project.canvas) {
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
}

window.addEventListener('resize', fitStage);

window.api.getActiveProject().then(render);
window.api.onProjectChanged(render);
