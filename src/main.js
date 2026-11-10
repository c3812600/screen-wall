'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const ConfigStore = require('./config');

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

function createPlayer() {
  playerWin = new BrowserWindow({
    show: false,
    fullscreen: !HEADLESS,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: '屏幕墙',
    webPreferences: windowWebPrefs(),
  });
  playerWin.loadFile(path.join(__dirname, 'player', 'player.html'));
  playerWin.once('ready-to-show', () => {
    if (!HEADLESS) playerWin.show();
  });
  playerWin.on('closed', () => {
    playerWin = null;
  });
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
    if (playerWin && !HEADLESS) playerWin.show();
  });
  return editorWin;
}

function buildTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  const menu = Menu.buildFromTemplate([
    { label: '编辑…', click: () => openEditor() },
    { label: '显示播放器', click: () => playerWin && playerWin.show() },
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
}

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

    // 功能流程：新建 → 视频 + 网站（页面缩放）保存 → 回读校验
    const flow = await editorWin.webContents.executeJavaScript(`(async () => {
      const created = await window.api.createProject({ name: '流程测试', width: 1000, height: 1000 });
      created.components.push({
        id: 't1', type: 'video', source: 'C:\\\\media\\\\demo.mp4',
        x: 10, y: 20, width: 640, height: 360,
        rotation: 90, mirrorX: true, mirrorY: false, zIndex: 1,
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
        component: c.type === 'video' && c.rotation === 90 && c.mirrorX === true &&
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
