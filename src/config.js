'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function nowIso() {
  return new Date().toISOString();
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * 存储布局（位于 app.getPath('userData')）：
 *   settings.json          { activeProjectId }
 *   projects/<id>.json     项目文件
 *
 * 项目文件 schema (version 1)：
 * {
 *   version: 1, id, name,
 *   canvas: { width, height },
 *   components: [{
 *     id, type: 'video'|'image'|'website', source,
 *     x, y, width, height, rotation, mirrorX, mirrorY, zIndex,
 *     video: { muted, volume }        // 仅 video
 *     web: { zoom }                   // 仅 website，页面缩放（1 = 100%）
 *   }],
 *   createdAt, updatedAt
 * }
 */
class ConfigStore {
  constructor(root) {
    this.root = root;
    this.projectsDir = path.join(root, 'projects');
    this.settingsPath = path.join(root, 'settings.json');
  }

  ensure() {
    fs.mkdirSync(this.projectsDir, { recursive: true });
    if (!fs.existsSync(this.settingsPath)) this.writeJson(this.settingsPath, {});
  }

  readJson(filePath, fallback) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return fallback;
    }
  }

  writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  readSettings() {
    return this.readJson(this.settingsPath, {});
  }

  setActiveProjectId(id) {
    const settings = this.readSettings();
    settings.activeProjectId = id || null;
    this.writeJson(this.settingsPath, settings);
  }

  getActiveProjectId() {
    return this.readSettings().activeProjectId || null;
  }

  projectPath(id) {
    return path.join(this.projectsDir, `${id}.json`);
  }

  listProjects() {
    this.ensure();
    return fs
      .readdirSync(this.projectsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.readJson(path.join(this.projectsDir, f), null))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .map((p) => ({
        id: p.id,
        name: p.name,
        canvas: p.canvas,
        componentCount: Array.isArray(p.components) ? p.components.length : 0,
        updatedAt: p.updatedAt,
      }));
  }

  loadProject(id) {
    if (!id) return null;
    return this.readJson(this.projectPath(id), null);
  }

  readActiveProject() {
    const project = this.loadProject(this.getActiveProjectId());
    if (project) return project;
    // 未指定（或指向已不存在的项目）时回退到最近保存的项目
    const list = this.listProjects();
    return list.length ? this.loadProject(list[0].id) : null;
  }

  createProject({ name, width, height } = {}) {
    this.ensure();
    const project = {
      version: 1,
      id: crypto.randomUUID(),
      name: String(name || '未命名项目').trim().slice(0, 60) || '未命名项目',
      canvas: {
        width: clampInt(width, 160, 16384, 1920),
        height: clampInt(height, 90, 16384, 1080),
      },
      components: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.writeJson(this.projectPath(project.id), project);
    return project;
  }

  saveProject(project) {
    if (!project || !project.id) throw new Error('项目缺少 id');
    const saved = {
      version: 1,
      id: String(project.id),
      name: String(project.name || '未命名项目').trim().slice(0, 60) || '未命名项目',
      canvas: {
        width: clampInt(project.canvas?.width, 160, 16384, 1920),
        height: clampInt(project.canvas?.height, 90, 16384, 1080),
      },
      components: Array.isArray(project.components) ? project.components : [],
      createdAt: project.createdAt || nowIso(),
      updatedAt: nowIso(),
    };
    this.writeJson(this.projectPath(saved.id), saved);
    return saved;
  }

  deleteProject(id) {
    try {
      fs.unlinkSync(this.projectPath(id));
    } catch {
      /* 忽略 */
    }
  }
}

module.exports = ConfigStore;
