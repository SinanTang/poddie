import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC, type PoddieApi, type TranscribeProgress } from '../shared/types'

const api: PoddieApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  selectMedia: () => ipcRenderer.invoke(IPC.selectMedia),
  openMediaPath: (path) => ipcRenderer.invoke(IPC.openMediaPath, path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  extractAudio: (videoPath) => ipcRenderer.invoke(IPC.extractAudio, videoPath),
  getApiKeyStatus: () => ipcRenderer.invoke(IPC.apiKeyStatus),
  setApiKey: (key) => ipcRenderer.invoke(IPC.apiKeySet, key),
  clearApiKey: () => ipcRenderer.invoke(IPC.apiKeyClear),
  loadProject: (videoPath, engine) => ipcRenderer.invoke(IPC.projectLoad, videoPath, engine),
  saveEdit: (videoPath, edit, engine) => ipcRenderer.invoke(IPC.projectSaveEdit, videoPath, edit, engine),
  transcribe: (videoPath, engine) => ipcRenderer.invoke(IPC.transcribeStart, videoPath, engine),
  onTranscribeProgress: (cb) => {
    const listener = (_event: IpcRendererEvent, p: TranscribeProgress): void => cb(p)
    ipcRenderer.on(IPC.transcribeProgress, listener)
    return () => ipcRenderer.removeListener(IPC.transcribeProgress, listener)
  },
  ensureProxy: (videoPath) => ipcRenderer.invoke(IPC.proxyEnsure, videoPath),
  onProxyProgress: (cb) => {
    const listener = (_event: IpcRendererEvent, fraction: number): void => cb(fraction)
    ipcRenderer.on(IPC.proxyProgress, listener)
    return () => ipcRenderer.removeListener(IPC.proxyProgress, listener)
  },
  getPeaks: (videoPath) => ipcRenderer.invoke(IPC.audioPeaks, videoPath),
  exportMedia: (videoPath, ranges, kind, burnInSrt) =>
    ipcRenderer.invoke(IPC.exportStart, videoPath, ranges, kind, burnInSrt),
  exportCaptions: (videoPath, srt) => ipcRenderer.invoke(IPC.captionsExport, videoPath, srt),
  cancelExport: () => ipcRenderer.invoke(IPC.exportCancel),
  getExportProgress: () => ipcRenderer.invoke(IPC.exportPoll),
  revealFile: (path) => ipcRenderer.invoke(IPC.exportReveal, path),
  getFeedbackTechInfo: () => ipcRenderer.invoke(IPC.feedbackTechInfo),
  openFeedbackIssue: (category, title, body) => ipcRenderer.invoke(IPC.feedbackOpen, category, title, body)
}

contextBridge.exposeInMainWorld('poddie', api)
