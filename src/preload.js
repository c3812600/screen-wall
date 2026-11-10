'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getActiveProject: () => ipcRenderer.invoke('projects:active'),
  loadProject: (id) => ipcRenderer.invoke('projects:load', id),
  createProject: (opts) => ipcRenderer.invoke('projects:create', opts),
  saveProject: (project) => ipcRenderer.invoke('projects:save', project),
  setActiveProject: (id) => ipcRenderer.invoke('projects:setActive', id),
  openMediaDialog: (type) => ipcRenderer.invoke('dialog:openMedia', type),
  quit: () => ipcRenderer.send('app:quit'),
  openEditor: () => ipcRenderer.send('editor:open'),
  onProjectChanged: (callback) =>
    ipcRenderer.on('project:changed', (_event, data) => callback(data)),
});
