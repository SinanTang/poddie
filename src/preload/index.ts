import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type PoddieApi, type TranscribeProgress } from '../shared/types'

const api: PoddieApi = {
  selectVideo: () => ipcRenderer.invoke(IPC.selectVideo),
  extractAudio: (videoPath) => ipcRenderer.invoke(IPC.extractAudio, videoPath),
  getApiKeyStatus: () => ipcRenderer.invoke(IPC.apiKeyStatus),
  setApiKey: (key) => ipcRenderer.invoke(IPC.apiKeySet, key),
  loadProject: (videoPath) => ipcRenderer.invoke(IPC.projectLoad, videoPath),
  transcribe: (videoPath) => ipcRenderer.invoke(IPC.transcribeStart, videoPath),
  onTranscribeProgress: (cb) => {
    const listener = (_event: IpcRendererEvent, p: TranscribeProgress): void => cb(p)
    ipcRenderer.on(IPC.transcribeProgress, listener)
    return () => ipcRenderer.removeListener(IPC.transcribeProgress, listener)
  }
}

contextBridge.exposeInMainWorld('poddie', api)
