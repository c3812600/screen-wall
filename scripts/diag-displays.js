'use strict';

// 诊断脚本：打印本机显示器数据与 3840×1080 的匹配结果（不创建窗口）
const { app, screen } = require('electron');
const { listDisplayRegions, pickDisplayRegion } = require('../src/display');

app.whenReady().then(() => {
  const displays = screen.getAllDisplays().map((d) => ({
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    primary: d.primary,
    label: d.label,
  }));
  console.log('DISPLAYS=' + JSON.stringify(displays));
  console.log('REGIONS=' + JSON.stringify(listDisplayRegions(displays)));
  console.log('PICK_3840x1080=' + JSON.stringify(pickDisplayRegion(displays, { width: 3840, height: 1080 })));
  app.exit(0);
});
