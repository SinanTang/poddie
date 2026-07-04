import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type PoddieApi } from '../shared/types'

const api: PoddieApi = {
  selectVideo: () => ipcRenderer.invoke(IPC.selectVideo),
  extractAudio: (videoPath) => ipcRenderer.invoke(IPC.extractAudio, videoPath)
}

contextBridge.exposeInMainWorld('poddie', api)
