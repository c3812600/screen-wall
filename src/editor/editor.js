'use strict';

const $ = (sel) => document.querySelector(sel);

const canvasEl = $('#canvas');
const viewport = $('#viewport');

let project = null;
let selectedId = null;
let dirty = false;

const TYPE_LABEL = { video: '视频', image: '图片', website: '网站' };

const HANDLE_SIGN = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

const EXT_TYPE = {
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video', m4v: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  html: 'website', htm: 'website',
};

function uid() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

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

function compById(id) {
  return (project?.components || []).find((c) => c.id === id) || null;
}

function compEl(id) {
  return canvasEl.querySelector(`.comp[data-id="${id}"]`);
}

function nextZIndex() {
  return (project.components || []).reduce((m, c) => Math.max(m, Number(c.zIndex) || 0), 0) + 1;
}

function canvasScale() {
  const rect = canvasEl.getBoundingClientRect();
  return rect.width / (project?.canvas?.width || 1) || 1;
}

function canvasPointToScreen(px, py) {
  const rect = canvasEl.getBoundingClientRect();
  const s = rect.width / project.canvas.width;
  return {
    x: rect.left + rect.width / 2 + (px - project.canvas.width / 2) * s,
    y: rect.top + rect.height / 2 + (py - project.canvas.height / 2) * s,
  };
}

function rotateVec(x, y, deg) {
  const r = (deg * Math.PI) / 180;
  return {
    x: x * Math.cos(r) - y * Math.sin(r),
    y: x * Math.sin(r) + y * Math.cos(r),
  };
}

/** 内容空间向量 → 画布空间偏移（先镜像，再旋转；对应 CSS rotate() scale()） */
function contentToCanvas(v, rotation, mirrorX, mirrorY) {
  return rotateVec(mirrorX ? -v.x : v.x, mirrorY ? -v.y : v.y, rotation);
}

/** 画布空间位移 → 内容空间位移 */
function deltaToContent(dx, dy, rotation, mirrorX, mirrorY) {
  const w = rotateVec(dx, dy, -rotation);
  return { x: mirrorX ? -w.x : w.x, y: mirrorY ? -w.y : w.y };
}

function markDirty() {
  dirty = true;
  $('#save-status').textContent = '有未保存的修改';
}

function renderMeta() {
  if (!project) return;
  const n = (project.components || []).length;
  $('#project-meta').textContent = `${project.name} · ${project.canvas.width}×${project.canvas.height} · ${n} 个组件`;
}

function applyCompStyle(el, c) {
  el.style.left = Math.round(c.x) + 'px';
  el.style.top = Math.round(c.y) + 'px';
  el.style.width = Math.round(c.width) + 'px';
  el.style.height = Math.round(c.height) + 'px';
  el.style.zIndex = String(Number(c.zIndex) || 0);
  el.style.transform = transformOf(c);
}

function sortedComponents() {
  return [...(project.components || [])].sort(
    (a, b) => (Number(a.zIndex) || 0) - (Number(b.zIndex) || 0),
  );
}

function buildCompEl(c) {
  const el = document.createElement('div');
  el.className = 'comp' + (c.id === selectedId ? ' selected' : '');
  el.dataset.id = c.id;
  applyCompStyle(el, c);

  const content = document.createElement('div');
  content.className = 'content';
  const url = toDisplayUrl(c.source);
  if (c.type === 'video' && url) {
    const v = document.createElement('video');
    v.src = url;
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.muted = c.video?.muted !== false;
    v.volume = Math.max(0, Math.min(1, Number(c.video?.volume) || 0));
    v.addEventListener('canplay', () => v.play().catch(() => {}));
    content.appendChild(v);
  } else if (c.type === 'image' && url) {
    const img = document.createElement('img');
    img.src = url;
    content.appendChild(img);
  } else if (c.type === 'website' && url) {
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    frame.setAttribute('scrolling', 'no');
    applyWebZoom(frame, c);
    content.appendChild(frame);
  } else {
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.textContent = `设置「${TYPE_LABEL[c.type] || c.type}」来源`;
    content.appendChild(ph);
  }
  el.appendChild(content);

  const box = document.createElement('div');
  box.className = 'frame';
  el.appendChild(box);
  const line = document.createElement('div');
  line.className = 'rot-line';
  el.appendChild(line);

  for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rot']) {
    const hd = document.createElement('div');
    hd.className = 'handle';
    hd.dataset.h = h;
    el.appendChild(hd);
  }
  return el;
}

/* ---------------- 视图：缩放 / 平移 ---------------- */

// 画布渲染变换：translate(ox, oy) scale(scale)，原点为视口左上角
const view = { scale: 1, ox: 0, oy: 0 };
let fitScale = 1;
let userZoomed = false;

function applyView() {
  if (!project) return;
  canvasEl.style.transform = `translate(${view.ox}px, ${view.oy}px) scale(${view.scale})`;
  $('#zoom-level').textContent = `${Math.round(view.scale * 100)}%`;
}

function fitView() {
  if (!project) return;
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  fitScale =
    Math.min((vw - 48) / project.canvas.width, (vh - 48) / project.canvas.height) || 1;
  view.scale = fitScale;
  view.ox = (vw - project.canvas.width * view.scale) / 2;
  view.oy = (vh - project.canvas.height * view.scale) / 2;
  userZoomed = false;
  applyView();
}

/** 以 (clientX, clientY) 为锚点缩放，锚点下的画布位置保持不动 */
function zoomAt(clientX, clientY, factor) {
  if (!project) return;
  const rect = viewport.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const prev = view.scale;
  const next = Math.max(0.02, Math.min(8, prev * factor));
  if (next === prev) return;
  const cx = (mx - view.ox) / prev;
  const cy = (my - view.oy) / prev;
  view.scale = next;
  view.ox = mx - cx * next;
  view.oy = my - cy * next;
  userZoomed = true;
  applyView();
}

function zoomCenter(factor) {
  const rect = viewport.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

viewport.addEventListener(
  'wheel',
  (e) => {
    if (!project) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  },
  { passive: false },
);

// 拖拽空白区域平移视图；单击空白取消选中
let panState = null;

viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.comp')) return;
  panState = {
    startX: e.clientX,
    startY: e.clientY,
    ox: view.ox,
    oy: view.oy,
    moved: false,
    pointerId: e.pointerId,
  };
  try {
    viewport.setPointerCapture(e.pointerId);
  } catch {
    /* 合成事件无真实指针 */
  }
});

viewport.addEventListener('pointermove', (e) => {
  if (!panState) return;
  const dx = e.clientX - panState.startX;
  const dy = e.clientY - panState.startY;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) panState.moved = true;
  view.ox = panState.ox + dx;
  view.oy = panState.oy + dy;
  applyView();
});

viewport.addEventListener('pointerup', (e) => {
  if (panState && !panState.moved) select(null);
  panState = null;
  try {
    viewport.releasePointerCapture(e.pointerId);
  } catch {
    /* 忽略 */
  }
});

function renderCanvas() {
  canvasEl.innerHTML = '';
  if (!project) return;
  canvasEl.style.width = project.canvas.width + 'px';
  canvasEl.style.height = project.canvas.height + 'px';
  for (const c of sortedComponents()) {
    canvasEl.appendChild(buildCompEl(c));
  }
  fitView();
  renderMeta();
}

/* ---------------- 选中与属性面板 ---------------- */

function select(id) {
  selectedId = id;
  canvasEl.querySelectorAll('.comp').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  renderProps();
}

function updateVideoPreview(c) {
  const v = compEl(c.id)?.querySelector('video');
  if (!v) return;
  v.muted = c.video?.muted !== false;
  v.volume = Math.max(0, Math.min(1, Number(c.video?.volume) || 0));
}

function updateWebPreview(c) {
  const frame = compEl(c.id)?.querySelector('iframe');
  if (frame) applyWebZoom(frame, c);
}

function renderProps() {
  const c = compById(selectedId);
  $('#props-empty').hidden = !!c;
  $('#props-form').hidden = !c;
  if (!c) return;
  $('#video-only').hidden = c.type !== 'video';
  $('#web-only').hidden = c.type !== 'website';
  $('#website-note').hidden = c.type !== 'website';
  $('#p-type').textContent = TYPE_LABEL[c.type] || c.type;
  $('#p-source').value = c.source || '';
  $('#p-rotation').value = String(Math.round(Number(c.rotation) || 0));
  $('#p-rot-text').textContent = `${Math.round(Number(c.rotation) || 0)}°`;
  $('#p-mirror-x').classList.toggle('on', !!c.mirrorX);
  $('#p-mirror-y').classList.toggle('on', !!c.mirrorY);
  $('#p-muted').checked = c.video?.muted !== false;
  $('#p-volume').value = String(Math.round((Number(c.video?.volume) || 0) * 100));
  $('#p-vol-text').textContent = `${Math.round((Number(c.video?.volume) || 0) * 100)}%`;
  const zpct = Math.round((Number(c.web?.zoom) || 1) * 100);
  $('#p-zoom').value = String(zpct);
  $('#p-zoom-text').textContent = `${zpct}%`;
  syncGeomInputs(c);
}

function syncGeomInputs(c) {
  $('#p-x').value = Math.round(c.x);
  $('#p-y').value = Math.round(c.y);
  $('#p-w').value = Math.round(c.width);
  $('#p-h').value = Math.round(c.height);
}

/* ---------------- 交互：拖动 / 缩放 / 旋转 ---------------- */

let dragState = null;

canvasEl.addEventListener('pointerdown', (e) => {
  const compNode = e.target.closest('.comp');
  if (!compNode) {
    select(null);
    return;
  }
  const c = compById(compNode.dataset.id);
  if (!c) return;
  select(c.id);

  const handleEl = e.target.closest('.handle');
  const handle = handleEl ? handleEl.dataset.h : null;
  const mode = !handle ? 'move' : handle === 'rot' ? 'rotate' : 'resize';

  const orig = {
    x: c.x,
    y: c.y,
    width: c.width,
    height: c.height,
    rotation: Number(c.rotation) || 0,
    mirrorX: !!c.mirrorX,
    mirrorY: !!c.mirrorY,
  };

  dragState = {
    mode,
    handle,
    id: c.id,
    startX: e.clientX,
    startY: e.clientY,
    orig,
    startAngle: 0,
  };

  if (mode === 'rotate') {
    const center = canvasPointToScreen(orig.x + orig.width / 2, orig.y + orig.height / 2);
    dragState.startAngle =
      (Math.atan2(e.clientY - center.y, e.clientX - center.x) * 180) / Math.PI;
  }

  try {
    canvasEl.setPointerCapture(e.pointerId);
  } catch {
    /* 合成事件无真实指针 */
  }
  e.preventDefault();
});

canvasEl.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const c = compById(dragState.id);
  const el = compEl(dragState.id);
  if (!c || !el) return;

  const s = canvasScale();
  const dx = (e.clientX - dragState.startX) / s;
  const dy = (e.clientY - dragState.startY) / s;
  const o = dragState.orig;

  if (dragState.mode === 'move') {
    c.x = o.x + dx;
    c.y = o.y + dy;
  } else if (dragState.mode === 'resize') {
    const [sx, sy] = HANDLE_SIGN[dragState.handle] || [0, 0];
    const v = deltaToContent(dx, dy, o.rotation, c.mirrorX, c.mirrorY);
    const w = Math.max(40, o.width + (sx ? v.x * sx : 0));
    const h = Math.max(40, o.height + (sy ? v.y * sy : 0));

    // 对角/对边锚点固定（旋转+镜像下保持锚点世界坐标不变）
    const anchor = { x: (-sx * o.width) / 2, y: (-sy * o.height) / 2 };
    const centerOld = { x: o.x + o.width / 2, y: o.y + o.height / 2 };
    const offOld = contentToCanvas(anchor, o.rotation, c.mirrorX, c.mirrorY);
    const anchorWorld = { x: centerOld.x + offOld.x, y: centerOld.y + offOld.y };

    const anchorNew = { x: (-sx * w) / 2, y: (-sy * h) / 2 };
    const offNew = contentToCanvas(anchorNew, o.rotation, c.mirrorX, c.mirrorY);

    c.width = w;
    c.height = h;
    c.x = anchorWorld.x - offNew.x - w / 2;
    c.y = anchorWorld.y - offNew.y - h / 2;
  } else if (dragState.mode === 'rotate') {
    const center = canvasPointToScreen(o.x + o.width / 2, o.y + o.height / 2);
    const ang = (Math.atan2(e.clientY - center.y, e.clientX - center.x) * 180) / Math.PI;
    let rot = (o.rotation + (ang - dragState.startAngle)) % 360;
    if (rot < 0) rot += 360;
    for (const snap of [0, 90, 180, 270, 360]) {
      if (Math.abs(rot - snap) < 3) rot = snap % 360;
    }
    c.rotation = Math.round(rot * 10) / 10;
  }

  applyCompStyle(el, c);
  syncGeomInputs(c);
  if (dragState.mode === 'rotate') {
    $('#p-rotation').value = String(Math.round(c.rotation));
    $('#p-rot-text').textContent = `${Math.round(c.rotation)}°`;
  }
  markDirty();
});

canvasEl.addEventListener('pointerup', () => {
  dragState = null;
});

/* ---------------- 增删组件 ---------------- */

function addComponent(type, source = '') {
  const w = type === 'website' ? 640 : 480;
  const h = type === 'website' ? 400 : 270;
  const offset = ((project.components || []).length % 5) * 40;
  const c = {
    id: uid(),
    type,
    source,
    x: Math.round((project.canvas.width - w) / 2 + offset),
    y: Math.round((project.canvas.height - h) / 2 + offset),
    width: w,
    height: h,
    rotation: 0,
    mirrorX: false,
    mirrorY: false,
    zIndex: nextZIndex(),
  };
  if (type === 'video') c.video = { muted: true, volume: 0 };
  if (type === 'website') c.web = { zoom: 1 };
  project.components.push(c);
  renderCanvas();
  select(c.id);
  markDirty();
}

function addComponentByPath(filePath) {
  const ext = String(filePath).split('.').pop().toLowerCase();
  const type = EXT_TYPE[ext];
  if (!type) return;
  addComponent(type, filePath);
}

function deleteSelected() {
  if (!selectedId) return;
  project.components = (project.components || []).filter((c) => c.id !== selectedId);
  select(null);
  renderCanvas();
  renderProps();
  markDirty();
}

/* ---------------- 工具栏 ---------------- */

function showStatus(text) {
  $('#save-status').textContent = text;
  dirty = false;
}

async function saveProject() {
  if (!project) return;
  project = await window.api.saveProject(project);
  showStatus('已保存 · 播放器已更新');
  renderMeta();
}

$('#btn-save').addEventListener('click', saveProject);
$('#btn-quit').addEventListener('click', () => window.api.quit());

$('#zoom-in').addEventListener('click', () => zoomCenter(1.2));
$('#zoom-out').addEventListener('click', () => zoomCenter(1 / 1.2));
$('#zoom-fit').addEventListener('click', fitView);

function screenSize() {
  return { w: Math.round(window.screen.width), h: Math.round(window.screen.height) };
}

function screenHintText() {
  const s = screenSize();
  return `当前屏幕：${s.w}×${s.h}`;
}

$('#btn-new').addEventListener('click', () => {
  const s = screenSize();
  $('#new-width').value = String(s.w);
  $('#new-height').value = String(s.h);
  $('#new-screen-hint').textContent = screenHintText();
  $('#dlg-new').showModal();
});

$('#new-use-screen').addEventListener('click', () => {
  const s = screenSize();
  $('#new-width').value = String(s.w);
  $('#new-height').value = String(s.h);
});
$('#form-new').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  project = await window.api.createProject({
    name: $('#new-name').value,
    width: Number($('#new-width').value),
    height: Number($('#new-height').value),
  });
  select(null);
  renderCanvas();
  renderProps();
  showStatus('');
});

$('#btn-canvas').addEventListener('click', () => {
  if (!project) return;
  $('#cv-width').value = String(project.canvas.width);
  $('#cv-height').value = String(project.canvas.height);
  $('#cv-screen-hint').textContent = screenHintText();
  $('#dlg-canvas').showModal();
});

$('#cv-use-screen').addEventListener('click', () => {
  const s = screenSize();
  $('#cv-width').value = String(s.w);
  $('#cv-height').value = String(s.h);
});
$('#form-canvas').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'ok') return;
  project.canvas.width = Math.max(160, Math.min(7680, Number($('#cv-width').value) || project.canvas.width));
  project.canvas.height = Math.max(90, Math.min(4320, Number($('#cv-height').value) || project.canvas.height));
  renderCanvas();
  renderProps();
  markDirty();
});

$('#btn-open').addEventListener('click', async () => {
  const list = await window.api.listProjects();
  const wrap = $('#open-list');
  wrap.innerHTML = '';
  if (!list.length) {
    wrap.innerHTML = '<p class="tip">还没有项目，先「新建项目」</p>';
  }
  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'open-item';
    row.innerHTML = `<span>${item.name}</span><span class="sub">${item.canvas.width}×${item.canvas.height} · ${item.componentCount} 个组件</span>`;
    row.addEventListener('click', async () => {
      const data = await window.api.loadProject(item.id);
      if (!data) return;
      await window.api.setActiveProject(item.id);
      project = data;
      select(null);
      renderCanvas();
      renderProps();
      showStatus('已打开 · 播放器已切换到该项目');
      $('#dlg-open').close();
    });
    wrap.appendChild(row);
  }
  $('#dlg-open').showModal();
});

/* ---------------- 属性面板事件 ---------------- */

function bindNum(id, apply) {
  $(id).addEventListener('input', () => {
    const c = compById(selectedId);
    if (!c) return;
    apply(c, Number($(id).value));
    const el = compEl(c.id);
    if (el) applyCompStyle(el, c);
    markDirty();
  });
}

bindNum('#p-x', (c, v) => (c.x = Number.isFinite(v) ? v : c.x));
bindNum('#p-y', (c, v) => (c.y = Number.isFinite(v) ? v : c.y));
bindNum('#p-w', (c, v) => (c.width = Math.max(20, v || c.width)));
bindNum('#p-h', (c, v) => (c.height = Math.max(20, v || c.height)));

$('#p-source').addEventListener('change', () => {
  const c = compById(selectedId);
  if (!c) return;
  c.source = $('#p-source').value.trim();
  renderCanvas();
  renderProps();
  markDirty();
});

$('#p-browse').addEventListener('click', async () => {
  const c = compById(selectedId);
  if (!c) return;
  const p = await window.api.openMediaDialog(c.type);
  if (!p) return;
  c.source = p;
  renderCanvas();
  renderProps();
  markDirty();
});

$('#p-rotation').addEventListener('input', () => {
  const c = compById(selectedId);
  if (!c) return;
  c.rotation = Number($('#p-rotation').value) || 0;
  $('#p-rot-text').textContent = `${Math.round(c.rotation)}°`;
  const el = compEl(c.id);
  if (el) applyCompStyle(el, c);
  markDirty();
});

$('#p-mirror-x').addEventListener('click', () => {
  const c = compById(selectedId);
  if (!c) return;
  c.mirrorX = !c.mirrorX;
  $('#p-mirror-x').classList.toggle('on', c.mirrorX);
  const el = compEl(c.id);
  if (el) applyCompStyle(el, c);
  markDirty();
});

$('#p-mirror-y').addEventListener('click', () => {
  const c = compById(selectedId);
  if (!c) return;
  c.mirrorY = !c.mirrorY;
  $('#p-mirror-y').classList.toggle('on', c.mirrorY);
  const el = compEl(c.id);
  if (el) applyCompStyle(el, c);
  markDirty();
});

$('#p-muted').addEventListener('change', () => {
  const c = compById(selectedId);
  if (!c) return;
  c.video = c.video || { muted: true, volume: 0 };
  c.video.muted = $('#p-muted').checked;
  updateVideoPreview(c);
  markDirty();
});

$('#p-volume').addEventListener('input', () => {
  const c = compById(selectedId);
  if (!c) return;
  c.video = c.video || { muted: true, volume: 0 };
  const pct = Number($('#p-volume').value) || 0;
  c.video.volume = pct / 100;
  if (pct > 0 && c.video.muted) {
    c.video.muted = false;
    $('#p-muted').checked = false;
  }
  $('#p-vol-text').textContent = `${pct}%`;
  updateVideoPreview(c);
  markDirty();
});

$('#p-zoom').addEventListener('input', () => {
  const c = compById(selectedId);
  if (!c) return;
  c.web = c.web || { zoom: 1 };
  const pct = Number($('#p-zoom').value) || 100;
  c.web.zoom = pct / 100;
  $('#p-zoom-text').textContent = `${pct}%`;
  updateWebPreview(c);
  markDirty();
});

$('#p-delete').addEventListener('click', deleteSelected);

/* ---------------- 组件面板与拖放 ---------------- */

document.querySelectorAll('.palette-item').forEach((item) => {
  item.addEventListener('click', () => addComponent(item.dataset.type));
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'new', type: item.dataset.type }));
    e.dataTransfer.effectAllowed = 'copy';
  });
});

viewport.addEventListener('dragover', (e) => {
  e.preventDefault();
  viewport.classList.add('drag-over');
  e.dataTransfer.dropEffect = 'copy';
});
viewport.addEventListener('dragleave', (e) => {
  if (!viewport.contains(e.relatedTarget)) viewport.classList.remove('drag-over');
});

viewport.addEventListener('drop', (e) => {
  e.preventDefault();
  viewport.classList.remove('drag-over');

  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) {
    const p = window.api.getPathForFile(file);
    if (p) {
      addComponentByPath(p);
      return;
    }
  }
  try {
    const data = JSON.parse(e.dataTransfer.getData('text/plain'));
    if (data && data.kind === 'new') addComponent(data.type);
  } catch {
    /* 忽略非组件拖放 */
  }
});

/* ---------------- 键盘 ---------------- */

window.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(e.target?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveProject();
    return;
  }
  if (typing) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
  }
});

window.addEventListener('resize', () => {
  if (!userZoomed) fitView();
});

/* ---------------- 初始化 ---------------- */

async function init() {
  let data = await window.api.getActiveProject();
  if (!data) {
    data = await window.api.createProject({ name: '我的屏幕墙', width: 1920, height: 1080 });
    showStatus('已创建默认项目');
  }
  project = data;
  renderCanvas();
  renderProps();
}

init();
