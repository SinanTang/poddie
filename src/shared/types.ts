export interface VideoInfo {
  path: string
  sizeBytes: number
  durationSec: number
  width: number
  height: number
  fps: number
  videoCodec: string
  audioCodec: string | null
  /** True when Chromium can't decode this codec (e.g. iPhone HEVC) and preview needs an H.264 proxy. */
  needsProxy: boolean
}

export interface AudioExtractResult {
  audioPath: string
  sizeBytes: number
}

export const IPC = {
  selectVideo: 'video:select',
  extractAudio: 'audio:extract'
} as const

/** The API the preload script exposes to the renderer as `window.poddie`. */
export interface PoddieApi {
  selectVideo(): Promise<VideoInfo | null>
  extractAudio(videoPath: string): Promise<AudioExtractResult>
}
