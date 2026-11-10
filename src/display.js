'use strict';

/**
 * 显示器区域计算（纯函数，供主进程与自检共用）。
 *
 * 说明：画布分辨率按「物理像素」口径理解（如 2 块 1920×1080 拼接 = 3840×1080），
 * 匹配时把 Electron 的 DIP bounds 乘 scaleFactor 换算成物理像素。
 * 不同缩放比（scaleFactor 不一致）的显示器组合视为不可拼接（拼缝会对不齐）。
 */

function toPhys(display) {
  const bounds = display.bounds;
  const scaleFactor = display.scaleFactor || 1;
  return {
    bounds,
    scaleFactor,
    pw: Math.round(bounds.width * scaleFactor),
    ph: Math.round(bounds.height * scaleFactor),
  };
}

/**
 * 列出可用于输出的区域：每块单屏 + 所有「无缝」连续组合。
 * 无缝 = 联合矩形面积等于各屏面积之和（无缺口、无重叠），且缩放比一致。
 * 返回 [{ label, width, height, dipBounds }]，width/height 为物理像素。
 */
function listDisplayRegions(displays) {
  const list = (displays || []).map(toPhys);
  const regions = [];

  list.forEach((d, i) => {
    regions.push({
      label: `显示器${i + 1}（${d.pw}×${d.ph}）`,
      width: d.pw,
      height: d.ph,
      dipBounds: { ...d.bounds },
    });
  });

  const sorted = [...list].sort(
    (a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y,
  );

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const sel = sorted.slice(i, j + 1);
      if (sel.some((d) => d.scaleFactor !== sel[0].scaleFactor)) continue;

      const minX = Math.min(...sel.map((d) => d.bounds.x));
      const minY = Math.min(...sel.map((d) => d.bounds.y));
      const maxX = Math.max(...sel.map((d) => d.bounds.x + d.bounds.width));
      const maxY = Math.max(...sel.map((d) => d.bounds.y + d.bounds.height));
      const unionArea = (maxX - minX) * (maxY - minY);
      const sumArea = sel.reduce((s, d) => s + d.bounds.width * d.bounds.height, 0);
      if (unionArea !== sumArea) continue; // 有缺口或重叠

      const dipBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      regions.push({
        label: `显示器${i + 1}–${j + 1} 拼接（${Math.round(dipBounds.width * sel[0].scaleFactor)}×${Math.round(dipBounds.height * sel[0].scaleFactor)}）`,
        width: Math.round(dipBounds.width * sel[0].scaleFactor),
        height: Math.round(dipBounds.height * sel[0].scaleFactor),
        dipBounds,
      });
    }
  }

  return regions;
}

/**
 * 挑选与画布物理分辨率精确匹配的输出区域；无匹配返回 null。
 * 返回值含 dipBounds（DIP 口径，可直接给 setBounds）。
 */
function pickDisplayRegion(displays, canvas) {
  if (!canvas || !canvas.width || !canvas.height) return null;
  return (
    listDisplayRegions(displays).find(
      (r) => r.width === canvas.width && r.height === canvas.height,
    ) || null
  );
}

module.exports = { listDisplayRegions, pickDisplayRegion };
