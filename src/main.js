'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  dialog,
  screen,
} = require('electron');
const path = require('node:path');
const os = require('node:os');
const ConfigStore = require('./config');
const { listDisplayRegions, pickDisplayRegion } = require('./display');

const SMOKE = process.argv.includes('--smoke-test');
const VERIFY = process.argv.includes('--verify-renderers');
const START_IN_EDITOR = process.argv.includes('--editor');
const HEADLESS = SMOKE || VERIFY;

// 自检模式使用隔离的临时存储：不抢真实配置，也不与运行中的实例争缓存
if (HEADLESS) {
  app.setPath(
    'userData',
    path.join(os.tmpdir(), `screen-wall-${VERIFY ? 'verify' : 'smoke'}-${Date.now()}`),
  );
}

const store = new ConfigStore(app.getPath('userData'));

let playerWin = null;
let editorWin = null;
let tray = null;

// 单实例：二次启动时拉起编辑器（自检模式旁路，允许与运行中的实例并存）
const gotLock = HEADLESS ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openEditor();
  });
}

function windowWebPrefs() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  };
}

/**
 * 播放器放置：
 * - 找到与画布物理分辨率精确匹配的显示器区域（单屏或无缝拼接）→ 无边框铺满该区域（跨屏）
 * - 无匹配 → 单显示器全屏（回退）
 */
function applyPlayerPlacement() {
  if (HEADLESS || !playerWin || playerWin.isDestroyed()) return;
  const project = store.readActiveProject();
  const region = pickDisplayRegion(screen.getAllDisplays(), project && project.canvas);
  if (region) {
    if (playerWin.isFullScreen()) playerWin.setFullScreen(false);
    playerWin.setBounds(region.dipBounds);
    playerWin.setAlwaysOnTop(true);
  } else {
    playerWin.setAlwaysOnTop(false);
    if (!playerWin.isFullScreen()) playerWin.setFullScreen(true);
  }
}

function createPlayer() {
  playerWin = new BrowserWindow({
    show: false,
    fullscreen: false,
    frame: false,
    // 去掉 Windows 隐形边框（WS_THICKFRAME）与缩放框，
    // 否则 setBounds 后实际渲染会整体偏移几个像素
    thickFrame: false,
    resizable: false,
    enableLargerThanScreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: '屏幕墙',
    webPreferences: windowWebPrefs(),
  });
  playerWin.loadFile(path.join(__dirname, 'player', 'player.html'));
  playerWin.once('ready-to-show', () => {
    applyPlayerPlacement();
    if (!HEADLESS) playerWin.show();
  });
  playerWin.on('closed', () => {
    playerWin = null;
  });
  return playerWin;
}

function openEditor() {
  if (editorWin) {
    editorWin.show();
    editorWin.focus();
    return editorWin;
  }
  editorWin = new BrowserWindow({
    show: false,
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    autoHideMenuBar: true,
    backgroundColor: '#1e1f22',
    title: '屏幕墙 · 编辑器',
    webPreferences: windowWebPrefs(),
  });
  editorWin.loadFile(path.join(__dirname, 'editor', 'editor.html'));
  editorWin.once('ready-to-show', () => {
    if (!HEADLESS) editorWin.show();
  });
  editorWin.on('closed', () => {
    editorWin = null;
    if (!HEADLESS) showPlayer();
  });
  return editorWin;
}

/** 显示播放器：窗口还在则前置，已被关闭则重建（与编辑器行为一致） */
function showPlayer() {
  if (playerWin && !playerWin.isDestroyed()) {
    playerWin.show();
    playerWin.focus();
    return playerWin;
  }
  return createPlayer();
}

function buildTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  const menu = Menu.buildFromTemplate([
    { label: '编辑…', click: () => openEditor() },
    { label: '显示播放器', click: () => showPlayer() },
    { type: 'separator' },
    { label: '退出屏幕墙', click: () => app.quit() },
  ]);
  tray.setToolTip('屏幕墙');
  tray.setContextMenu(menu);
  tray.on('double-click', () => openEditor());
}

function broadcastProject() {
  if (!playerWin) return;
  playerWin.webContents.send('project:changed', store.readActiveProject());
  applyPlayerPlacement();
}

ipcMain.handle('displays:layout', () => listDisplayRegions(screen.getAllDisplays()));
ipcMain.handle('displays:match', (_event, canvas) =>
  pickDisplayRegion(screen.getAllDisplays(), canvas),
);

ipcMain.handle('projects:list', () => store.listProjects());
ipcMain.handle('projects:active', () => store.readActiveProject());
ipcMain.handle('projects:load', (_event, id) => store.loadProject(id));
ipcMain.handle('projects:create', (_event, opts) => {
  const project = store.createProject(opts || {});
  store.setActiveProjectId(project.id);
  broadcastProject();
  return project;
});
ipcMain.handle('projects:save', (_event, project) => {
  const saved = store.saveProject(project);
  store.setActiveProjectId(saved.id);
  broadcastProject();
  return saved;
});
ipcMain.handle('projects:setActive', (_event, id) => {
  store.setActiveProjectId(id);
  broadcastProject();
  return store.readActiveProject();
});

ipcMain.handle('dialog:openMedia', async (_event, type) => {
  // 自检模式返回固定路径，避免弹出真实对话框阻塞自动化
  if (HEADLESS) {
    const ext = type === 'image' ? 'png' : type === 'video' ? 'mp4' : 'html';
    return `C:\\media\\picked-demo.${ext}`;
  }
  const filters =
    type === 'video'
      ? [{ name: '视频', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'] }]
      : type === 'image'
        ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
        : [
            { name: '网页', extensions: ['html', 'htm'] },
            { name: '所有文件', extensions: ['*'] },
          ];
  const options = {
    properties: ['openFile'],
    filters,
  };
  const result = editorWin
    ? await dialog.showOpenDialog(editorWin, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.on('app:quit', () => app.quit());
ipcMain.on('editor:open', () => openEditor());

/* ---------------- 自检模式 ---------------- */

function startSmoke() {
  setTimeout(() => {
    const ok = Array.isArray(store.listProjects());
    console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
    app.exit(ok ? 0 : 1);
  }, 2500);
}

async function startVerify() {
  const problems = [];
  const watch = (win, label) => {
    if (!win) return;
    win.webContents.on('console-message', (event) => {
      const level = event.level ?? event.detail?.level;
      const message = String(event.message ?? event.detail?.message ?? '');
      const isError = level === 3 || level === 'error';
      if (isError || /uncaught|typeerror|referenceerror|is not a function|cannot read/i.test(message)) {
        problems.push(`[${label}] console: ${message}`);
      }
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      problems.push(`[${label}] did-fail-load: ${code} ${desc} (${url})`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      problems.push(`[${label}] render-process-gone: ${details.reason}`);
    });
  };
  watch(playerWin, 'player');
  watch(editorWin, 'editor');

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (cond, label) => {
    if (!cond) problems.push(`[assert] ${label}`);
  };

  // 等编辑器 init() 完成
  await wait(2500);

  try {
    // 跨屏匹配算法断言（纯函数，覆盖单屏/拼接/高 DPI/缺口/混合缩放/纵向）
    {
      const two1080 = [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
        { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      ];
      const joined = pickDisplayRegion(two1080, { width: 3840, height: 1080 });
      assert(
        !!joined && joined.dipBounds.width === 3840 && joined.dipBounds.height === 1080,
        `双屏拼接 3840×1080 匹配失败: ${JSON.stringify(joined)}`,
      );
      assert(!!pickDisplayRegion(two1080, { width: 1920, height: 1080 }), '单屏 1920×1080 匹配失败');
      assert(pickDisplayRegion(two1080, { width: 2560, height: 1440 }) === null, '尺寸不符时应无匹配');

      const hidpi = [
        { bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 },
        { bounds: { x: 1536, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25 },
      ];
      assert(!!pickDisplayRegion(hidpi, { width: 3840, height: 1080 }), '高 DPI 拼接匹配失败');

      const gapped = [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
        { bounds: { x: 2000, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      ];
      assert(pickDisplayRegion(gapped, { width: 3840, height: 1080 }) === null, '存在缺口时不应匹配');

      // 排列偏移 4px（真实环境第二块屏 y=4）应在容差内匹配；大偏移不应匹配
      const nudged = [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
        { bounds: { x: 1920, y: 4, width: 1920, height: 1080 }, scaleFactor: 1 },
      ];
      assert(!!pickDisplayRegion(nudged, { width: 3840, height: 1080 }), '排列偏移 4px 应在容差内匹配');
      const offsetBig = [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
        { bounds: { x: 1920, y: 200, width: 1920, height: 1080 }, scaleFactor: 1 },
      ];
      assert(pickDisplayRegion(offsetBig, { width: 3840, height: 1080 }) === null, '大偏移不应匹配');

      const stacked = [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
        { bounds: { x: 0, y: 1080, width: 1920, height: 1080 }, scaleFactor: 1 },
      ];
      assert(!!pickDisplayRegion(stacked, { width: 1920, height: 2160 }), '纵向拼接匹配失败');

      const regions = listDisplayRegions(two1080);
      assert(regions.length === 3, `双屏应输出 3 个区域（2 单屏 + 1 拼接），实际 ${regions.length}`);
    }

    // 正向断言：页面骨架
    const editorDom = await editorWin.webContents.executeJavaScript(`({
      palettes: document.querySelectorAll('.palette-item').length,
      hasCanvas: !!document.getElementById('canvas'),
      hasZoomBar: !!document.getElementById('zoom-bar'),
      hasApi: typeof window.api.saveProject === 'function',
    })`);
    assert(editorDom.palettes === 3, `编辑器组件面板应为 3 项，实际 ${editorDom.palettes}`);
    assert(editorDom.hasCanvas, '编辑器画布不存在');
    assert(editorDom.hasZoomBar, '缩放工具条不存在');
    assert(editorDom.hasApi, 'preload API 未注入');

    // 回归断言：画布显示比例必须等于项目分辨率比例（防 flex 压缩变形）
    const aspect = await editorWin.webContents.executeJavaScript(`(() => {
      const r = document.getElementById('canvas').getBoundingClientRect();
      return { w: r.width, h: r.height };
    })()`);
    assert(aspect.w > 0 && aspect.h > 0, '编辑器画布不可见');
    assert(
      Math.abs(aspect.w / aspect.h - 1920 / 1080) < 0.02,
      `编辑器画布比例失真: ${Math.round(aspect.w)}×${Math.round(aspect.h)}`,
    );

    // 功能断言：滚轮缩放、拖拽平移
    const zoom = await editorWin.webContents.executeJavaScript(`(() => {
      const vp = document.getElementById('viewport');
      const el = document.getElementById('canvas');
      const before = getComputedStyle(el).transform;
      const r = vp.getBoundingClientRect();
      vp.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -120, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true,
      }));
      const afterWheel = getComputedStyle(el).transform;
      vp.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0, clientX: r.left + 100, clientY: r.top + 100, bubbles: true, cancelable: true,
      }));
      vp.dispatchEvent(new PointerEvent('pointermove', {
        clientX: r.left + 140, clientY: r.top + 130, bubbles: true, cancelable: true,
      }));
      vp.dispatchEvent(new PointerEvent('pointerup', {
        clientX: r.left + 140, clientY: r.top + 130, bubbles: true, cancelable: true,
      }));
      return { before, afterWheel, afterPan: getComputedStyle(el).transform };
    })()`);
    assert(zoom.afterWheel !== zoom.before, '滚轮缩放未生效');
    assert(zoom.afterPan !== zoom.afterWheel, '拖拽平移未生效');

    // 功能断言：拖放落在鼠标位置、双击直接选素材（HEADLESS 下对话框返回固定路径）
    const dropDbl = await editorWin.webContents.executeJavaScript(`(async () => {
      document.getElementById('zoom-fit').click();
      await new Promise((res) => setTimeout(res, 50));
      const vp = document.getElementById('viewport');
      const r = vp.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData('text/plain', JSON.stringify({ kind: 'new', type: 'image' }));
      vp.dispatchEvent(new DragEvent('drop', {
        dataTransfer: dt, clientX: r.left + 200, clientY: r.top + 150,
        bubbles: true, cancelable: true,
      }));
      await new Promise((res) => setTimeout(res, 50));
      const comp = document.querySelector('#canvas .comp');
      // pointerdown 不得被取消：取消会抑制浏览器生成 dblclick（真实环境双击失效的根因）
      const notCancelled = comp.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0,
        clientX: r.left + 200, clientY: r.top + 150,
      }));
      comp.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, button: 0,
        clientX: r.left + 200, clientY: r.top + 150,
      }));
      comp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await new Promise((res) => setTimeout(res, 150));
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 's', ctrlKey: true, bubbles: true, cancelable: true,
      }));
      await new Promise((res) => setTimeout(res, 300));
      const saved = await window.api.getActiveProject();
      const c = (saved.components || [])[0] || {};
      // 期望坐标 = 编辑器 clientToCanvas 同一公式（初始项目 1920×1080，适应窗口后）
      const vw = vp.clientWidth;
      const vh = vp.clientHeight;
      const s = Math.min((vw - 48) / 1920, (vh - 48) / 1080);
      const ox = (vw - 1920 * s) / 2;
      const oy = (vh - 1080 * s) / 2;
      return {
        notCancelled,
        count: (saved.components || []).length,
        type: c.type,
        x: c.x, y: c.y,
        ex: Math.round((200 - ox) / s - 240),
        ey: Math.round((150 - oy) / s - 135),
        source: c.source,
      };
    })()`);
    assert(dropDbl.notCancelled === true, 'pointerdown 不应被取消（否则浏览器不生成 dblclick）');
    assert(
      dropDbl.count === 1 && dropDbl.type === 'image',
      `拖放后应新增 1 个图片组件: ${JSON.stringify(dropDbl)}`,
    );
    assert(
      Math.abs(dropDbl.x - dropDbl.ex) <= 2 && Math.abs(dropDbl.y - dropDbl.ey) <= 2,
      `拖放位置应落在鼠标处: got ${dropDbl.x},${dropDbl.y} expect ${dropDbl.ex},${dropDbl.ey}`,
    );
    assert(
      String(dropDbl.source).endsWith('picked-demo.png'),
      `双击应直接选素材: ${dropDbl.source}`,
    );

    // 图层断言：新增第二个组件 → 图层面板 2 行；下移一层后该组件变底层（zIndex 归一化 1..n）
    const zTest = await editorWin.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const vp = document.getElementById('viewport');
      const r = vp.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData('text/plain', JSON.stringify({ kind: 'new', type: 'image' }));
      vp.dispatchEvent(new DragEvent('drop', {
        dataTransfer: dt, clientX: r.left + 400, clientY: r.top + 300,
        bubbles: true, cancelable: true,
      }));
      await sleep(50);
      const rows = document.querySelectorAll('#layer-list .layer-row').length;
      document.getElementById('p-z-down').click();
      await sleep(50);
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 's', ctrlKey: true, bubbles: true, cancelable: true,
      }));
      await sleep(300);
      const saved = await window.api.getActiveProject();
      const byZ = (saved.components || []).slice().sort((a, b) => a.zIndex - b.zIndex);
      const vw = vp.clientWidth, vh = vp.clientHeight;
      const s = Math.min((vw - 48) / 1920, (vh - 48) / 1080);
      const ox = (vw - 1920 * s) / 2;
      return {
        rows,
        zValues: byZ.map((c) => c.zIndex),
        bottomX: byZ[0] ? byZ[0].x : null,
        expectBottomX: Math.round((400 - ox) / s - 240),
        dump: byZ.map((c) => c.id.slice(-4) + '@x' + c.x + ':z' + c.zIndex).join(' | '),
        sel: (() => {
          const el = document.querySelector('#canvas .comp.selected');
          return el ? el.dataset.id.slice(-4) : null;
        })(),
        dis: document.getElementById('p-z-down').disabled,
      };
    })()`);
    assert(zTest.rows === 2, `图层面板应有 2 行，实际 ${zTest.rows}`);
    assert(zTest.zValues.join(',') === '1,2', `zIndex 应归一化为 1,2，实际 ${zTest.zValues.join(',')}`);
    assert(
      Math.abs(zTest.bottomX - zTest.expectBottomX) <= 2,
      `下移一层后新组件应变底层: ${zTest.bottomX} vs ${zTest.expectBottomX} | dump=${zTest.dump} sel=${zTest.sel} dis=${zTest.dis}`,
    );

    // 锁定断言：锁定后属性禁用、显示标记、拖动不生效
    const lockTest = await editorWin.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const first = document.querySelector('#canvas .comp');
      const id = first.dataset.id;
      const beforeLeft = first.style.left;
      first.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, clientX: 50, clientY: 50,
      }));
      first.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, button: 0, clientX: 50, clientY: 50,
      }));
      await sleep(50);
      document.getElementById('p-lock').click();
      await sleep(80);
      const disabled = document.getElementById('p-x').disabled;
      const lockOn = document.getElementById('p-lock').classList.contains('on');
      const badge = !!document.querySelector('#canvas .comp.locked .lock-badge');
      const layerLockOn = !!document.querySelector('#layer-list .layer-lock.on');
      const cur = document.querySelector('#canvas .comp[data-id="' + id + '"]');
      cur.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 300,
      }));
      cur.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, clientX: 500, clientY: 500,
      }));
      cur.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, clientX: 500, clientY: 500,
      }));
      await sleep(50);
      const afterLeft = document.querySelector('#canvas .comp[data-id="' + id + '"]').style.left;
      return { disabled, lockOn, badge, layerLockOn, beforeLeft, afterLeft };
    })()`);
    assert(
      lockTest.disabled === true && lockTest.lockOn === true,
      `锁定后属性应禁用: ${JSON.stringify(lockTest)}`,
    );
    assert(lockTest.badge && lockTest.layerLockOn, '锁定组件应显示锁定标记并同步图层锁状态');
    assert(
      lockTest.beforeLeft === lockTest.afterLeft,
      `锁定后拖动不应生效: ${lockTest.beforeLeft} -> ${lockTest.afterLeft}`,
    );

    // 快捷键断言：面板点击不添加组件；复制粘贴、撤销、重做
    const kbTest = await editorWin.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const key = (opts) => window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, opts)));
      const domCount = () => document.querySelectorAll('#canvas .comp').length;
      const before = domCount();
      document.querySelector('.palette-item[data-type="video"]').click();
      await sleep(50);
      const afterClick = domCount();
      const first = document.querySelector('#canvas .comp');
      first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 40, clientY: 40 }));
      first.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 40, clientY: 40 }));
      await sleep(30);
      key({ key: 'c', ctrlKey: true });
      key({ key: 'v', ctrlKey: true });
      await sleep(50);
      const afterPaste = domCount();
      key({ key: 'z', ctrlKey: true });
      await sleep(50);
      const afterUndo = domCount();
      key({ key: 'y', ctrlKey: true });
      await sleep(50);
      const afterRedo = domCount();
      return { before, afterClick, afterPaste, afterUndo, afterRedo };
    })()`);
    assert(kbTest.afterClick === kbTest.before, `面板点击不应添加组件: ${JSON.stringify(kbTest)}`);
    assert(kbTest.afterPaste === kbTest.before + 1, `Ctrl+V 应粘贴出新组件: ${JSON.stringify(kbTest)}`);
    assert(kbTest.afterUndo === kbTest.before, `Ctrl+Z 应撤销粘贴: ${JSON.stringify(kbTest)}`);
    assert(kbTest.afterRedo === kbTest.before + 1, `Ctrl+Y 应重做粘贴: ${JSON.stringify(kbTest)}`);

    // 功能流程：新建 → 视频 + 网站（页面缩放）保存 → 回读校验
    const flow = await editorWin.webContents.executeJavaScript(`(async () => {
      const created = await window.api.createProject({ name: '流程测试', width: 1000, height: 1000 });
      created.components.push({
        id: 't1', type: 'video', source: 'C:\\\\media\\\\demo.mp4',
        x: 10, y: 20, width: 640, height: 360,
        rotation: 90, mirrorX: true, mirrorY: false, zIndex: 1, locked: true,
        video: { muted: false, volume: 0.5 }
      });
      created.components.push({
        id: 't2', type: 'website', source: 'https://example.com',
        x: 300, y: 300, width: 800, height: 600,
        rotation: 0, mirrorX: false, mirrorY: false, zIndex: 2,
        web: { zoom: 1.5 }
      });
      const saved = await window.api.saveProject(created);
      const back = await window.api.getActiveProject();
      const c = (back && back.components && back.components[0]) || {};
      const w = (back && back.components && back.components[1]) || {};
      return {
        idKept: saved && saved.id === created.id,
        canvas: !!back && back.canvas.width === 1000 && back.canvas.height === 1000,
        component: c.type === 'video' && c.rotation === 90 && c.mirrorX === true && c.locked === true &&
          c.video && c.video.muted === false && c.video.volume === 0.5,
        webZoom: w.type === 'website' && w.web && w.web.zoom === 1.5,
      };
    })()`);
    assert(flow.idKept, '保存后项目 id 应保持一致');
    assert(flow.canvas, '画布分辨率回读不符');
    assert(flow.component, '组件属性（旋转/镜像/音量）回读不符');
    assert(flow.webZoom, '网站页面缩放回读不符');

    // 回归断言：active 指向不存在的项目时，应回退到最近保存的项目
    const fallback = await editorWin.webContents.executeJavaScript(`(async () => {
      await window.api.setActiveProject('no-such-project-id');
      const p = await window.api.getActiveProject();
      return { name: p && p.name };
    })()`);
    assert(fallback.name === '流程测试', `无效 active 应回退到最近项目，实际 ${fallback.name}`);

    // 播放器应收到 project:changed：2 个组件、iframe 缩放生效、画布比例 1:1
    await wait(600);
    const playerDom = await playerWin.webContents.executeJavaScript(`(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      const f = document.querySelector('#stage iframe');
      return {
        comps: document.querySelectorAll('#stage .comp').length,
        hasVideo: !!document.querySelector('#stage video'),
        iframe: f ? { transform: f.style.transform, width: parseFloat(f.style.width) } : null,
        aspect: r.height > 0 ? r.width / r.height : 0,
      };
    })()`);
    assert(playerDom.comps === 2, `播放器应渲染 2 个组件，实际 ${playerDom.comps}`);
    assert(playerDom.hasVideo, '播放器未渲染 video 元素');
    assert(
      playerDom.iframe && playerDom.iframe.transform === 'scale(1.5)' &&
        Math.abs(playerDom.iframe.width - 100 / 1.5) < 0.01,
      `播放器 iframe 页面缩放未生效: ${JSON.stringify(playerDom.iframe)}`,
    );
    assert(
      Math.abs(playerDom.aspect - 1) < 0.02,
      `播放器画布比例失真: ${playerDom.aspect.toFixed(3)}`,
    );

    // 播放器映射模式：窗口≈画布 → 精确填满（坐标 1:1）；差异大 → 等比缩放
    playerWin.setBounds({ x: 0, y: 0, width: 1000, height: 1000 });
    await wait(300);
    const fill = await playerWin.webContents.executeJavaScript(`(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      return { w: r.width, h: r.height };
    })()`);
    assert(
      Math.abs(fill.w - 1000) <= 2 && Math.abs(fill.h - 1000) <= 2,
      `窗口≈画布时应精确填满: ${JSON.stringify(fill)}`,
    );
    playerWin.setBounds({ x: 0, y: 0, width: 1000, height: 500 });
    await wait(300);
    const boxed = await playerWin.webContents.executeJavaScript(`(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      return { w: r.width, h: r.height };
    })()`);
    assert(
      Math.abs(boxed.w - 500) <= 2 && Math.abs(boxed.h - 500) <= 2,
      `窗口差异大时应等比缩放: ${JSON.stringify(boxed)}`,
    );

    // 回归断言：关闭播放器后「显示播放器」应能重建窗口
    playerWin.close();
    await wait(300);
    showPlayer();
    await wait(1500);
    const revived =
      playerWin && !playerWin.isDestroyed()
        ? await playerWin.webContents.executeJavaScript(`!!document.getElementById('stage')`)
        : false;
    assert(revived, '关闭播放器后应能通过托盘重建');
  } catch (err) {
    problems.push(`[verify] 执行断言时抛错: ${err && err.message}`);
  }

  if (problems.length) {
    console.log('VERIFY FAIL');
    for (const p of problems) console.log(' -', p);
    app.exit(1);
  } else {
    console.log('VERIFY OK');
    app.exit(0);
  }
}

app.whenReady().then(() => {
  store.ensure();
  buildTray();
  createPlayer();

  const active = store.readActiveProject();
  if (!active || START_IN_EDITOR) openEditor();

  if (VERIFY) startVerify();
  else if (SMOKE) startSmoke();
});

// 常驻托盘：关闭所有窗口也不退出
app.on('window-all-closed', () => {});
