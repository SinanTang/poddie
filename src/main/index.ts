import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractAudio, probeVideo } from './media'
import { IPC } from '../shared/types'

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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
