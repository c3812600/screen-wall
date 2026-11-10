'use strict';

/**
 * 显示器区域计算（纯函数，供主进程与自检共用）。
 *
 * 说明：画布分辨率按「物理像素」口径理解（如 2 块 1920×1080 拼接 = 3840×1080），
 * 匹配时把 Electron 的 DIP bounds 乘 scaleFactor 换算成物理像素。
 * Windows 显示排列常有几像素的偏移（如 y=4），因此对组合采用容差匹配：
 * 近似无缝（缝隙/重叠 ≤ 约 8px 级别）即可列出，物理尺寸与画布相差 ≤ 2% 即视为匹配。
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

function regionOf(sel) {
  const minX = Math.min(...sel.map((d) => d.bounds.x));
  const minY = Math.min(...sel.map((d) => d.bounds.y));
  const maxX = Math.max(...sel.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...sel.map((d) => d.bounds.y + d.bounds.height));
  const dipBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

  // 面积加权平均缩放比：同缩放比时精确，混合缩放时近似
  const areaSum = sel.reduce((s, d) => s + d.bounds.width * d.bounds.height, 0);
  const weighted = sel.reduce(
    (s, d) => s + d.bounds.width * d.bounds.height * d.scaleFactor,
    0,
  );
  const scale = weighted / areaSum;

  return {
    width: Math.round(dipBounds.width * scale),
    height: Math.round(dipBounds.height * scale),
    dipBounds,
  };
}

/** 近似无缝：缝隙/重叠造成的面积差不超过 (宽+高)×8 像素量级 */
function isNearlySeamless(sel, region) {
  const unionArea = region.dipBounds.width * region.dipBounds.height;
  const sumArea = sel.reduce((s, d) => s + d.bounds.width * d.bounds.height, 0);
  const slack = (region.dipBounds.width + region.dipBounds.height) * 8;
  return Math.abs(unionArea - sumArea) <= slack;
}

/**
 * 列出可用于输出的区域：每块单屏 + 所有近似无缝的连续组合。
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
      const region = regionOf(sel);
      if (!isNearlySeamless(sel, region)) continue;
      regions.push({
        label: `显示器${i + 1}–${j + 1} 拼接（${region.width}×${region.height}）`,
        width: region.width,
        height: region.height,
        dipBounds: region.dipBounds,
      });
    }
  }

  return regions;
}

/**
 * 挑选与画布物理分辨率匹配的输出区域；无匹配返回 null。
 * 先精确匹配，再按容差（±2%，下限 8px）匹配；返回值含 dipBounds（可直接给 setBounds）。
 */
function pickDisplayRegion(displays, canvas) {
  if (!canvas || !canvas.width || !canvas.height) return null;
  const regions = listDisplayRegions(displays);
  const exact = regions.find(
    (r) => r.width === canvas.width && r.height === canvas.height,
  );
  if (exact) return exact;

  const slackW = Math.max(8, Math.round(canvas.width * 0.02));
  const slackH = Math.max(8, Math.round(canvas.height * 0.02));
  return (
    regions.find(
      (r) =>
        Math.abs(r.width - canvas.width) <= slackW &&
        Math.abs(r.height - canvas.height) <= slackH,
    ) || null
  );
}

module.exports = { listDisplayRegions, pickDisplayRegion };
