import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractAudio, probeVideo } from './media'
import { getApiKey, getApiKeyStatus, setApiKey } from './config'
import { loadProject } from './project'
import { transcribeVideo } from './transcribe'
import { IPC, type TranscribeProgress } from '../shared/types'

// The renderer loads local video files via media:// (file:// is blocked from
// an http:// dev-server origin). stream + supportFetchAPI let <video> seek.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { supportFetchAPI: true, stream: true, bypassCSP: true } }
])

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Poddie',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  protocol.handle('media', (request) => {
    const { pathname } = new URL(request.url)
    const filePath = decodeURIComponent(pathname)
    return net.fetch(pathToFileURL(filePath).toString(), { headers: request.headers })
  })

  ipcMain.handle(IPC.selectVideo, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: ['mov', 'mp4', 'm4v'] }]
    })
    if (canceled || filePaths.length === 0) return null
    return probeVideo(filePaths[0])
  })

  ipcMain.handle(IPC.extractAudio, async (_event, videoPath: string) => {
    return extractAudio(videoPath, join(app.getPath('userData'), 'cache'))
  })

  ipcMain.handle(IPC.apiKeyStatus, async () => getApiKeyStatus(app.getPath('userData')))

  ipcMain.handle(IPC.apiKeySet, async (_event, key: string) => setApiKey(app.getPath('userData'), key))

  ipcMain.handle(IPC.projectLoad, async (_event, videoPath: string) => loadProject(videoPath))

  ipcMain.handle(IPC.transcribeStart, async (event, videoPath: string) => {
    const { key } = await getApiKey(app.getPath('userData'))
    if (!key) throw new Error('No OpenAI API key configured — set OPENAI_API_KEY or save a key in the app')
    return transcribeVideo(videoPath, {
      cacheDir: join(app.getPath('userData'), 'cache'),
      apiKey: key,
      onProgress: (p: TranscribeProgress) => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC.transcribeProgress, p)
      }
    })
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
