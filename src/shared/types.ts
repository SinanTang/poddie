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

export interface TranscriptWord {
  text: string
  start: number
  end: number
}

export interface TranscriptSegment {
  text: string
  start: number
  end: number
}

export interface Transcript {
  language: string
  durationSec: number
  model: string
  createdAt: string
  /** Actual API cost, from extracted-audio duration. Absent in pre-cost project files. */
  costUsd?: number
  words: TranscriptWord[]
  /** Whisper's sentence-level segments — used for paragraph breaks in the UI. */
  segments: TranscriptSegment[]
}

export interface VideoFingerprint {
  sizeBytes: number
  mtimeMs: number
}

export interface Project {
  version: 1
  videoPath: string
  fingerprint: VideoFingerprint
  transcript: Transcript | null
  /** Edit state (words + gap tokens with removed flags); null until first edit. */
  edit?: import('./edit').EditState | null
  updatedAt: string
}

export interface TranscribeProgress {
  stage: 'extracting' | 'analyzing' | 'transcribing' | 'saving' | 'done' | 'error'
  message: string
  /** Overall completion in [0, 1]. */
  fraction: number
}

export interface ApiKeyStatus {
  present: boolean
  source: 'env' | 'config' | null
}

export interface PeaksResult {
  /** Max-abs amplitude per bucket, normalized 0..1. */
  peaks: number[]
  duration: number
}

export interface AppInfo {
  logPath: string
  /** Prefix for media URLs: `${mediaBaseUrl}/${encodeURIComponent(absPath)}` */
  mediaBaseUrl: string
  /** Whether ffmpeg has the subtitles (libass) filter — gates caption burn-in. */
  canBurnCaptions: boolean
}

export const IPC = {
  appInfo: 'app:info',
  selectVideo: 'video:select',
  extractAudio: 'audio:extract',
  apiKeyStatus: 'apiKey:status',
  apiKeySet: 'apiKey:set',
  projectLoad: 'project:load',
  projectSaveEdit: 'project:saveEdit',
  transcribeStart: 'transcribe:start',
  transcribeProgress: 'transcribe:progress',
  proxyEnsure: 'proxy:ensure',
  proxyProgress: 'proxy:progress',
  audioPeaks: 'audio:peaks',
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportPoll: 'export:poll',
  exportReveal: 'export:reveal',
  captionsExport: 'captions:export'
} as const

/** The API the preload script exposes to the renderer as `window.poddie`. */
export interface PoddieApi {
  getAppInfo(): Promise<AppInfo>
  selectVideo(): Promise<VideoInfo | null>
  extractAudio(videoPath: string): Promise<AudioExtractResult>
  getApiKeyStatus(): Promise<ApiKeyStatus>
  setApiKey(key: string): Promise<ApiKeyStatus>
  loadProject(videoPath: string): Promise<Project | null>
  saveEdit(videoPath: string, edit: import('./edit').EditState): Promise<void>
  /** Resolves to null when the user cancels the cost-confirmation dialog. */
  transcribe(videoPath: string): Promise<Project | null>
  /** Subscribe to transcription progress; returns an unsubscribe function. */
  onTranscribeProgress(cb: (p: TranscribeProgress) => void): () => void
  /** Create or fetch the cached H.264 preview proxy (for HEVC sources). */
  ensureProxy(videoPath: string): Promise<{ proxyPath: string }>
  onProxyProgress(cb: (fraction: number) => void): () => void
  getPeaks(videoPath: string): Promise<PeaksResult>
  /**
   * Save dialog + cut/concat/re-encode. 'video' → mp4; 'audio' → m4a or mp3
   * (chosen in the save dialog) for podcast feeds. Pass `burnInSrt` (SRT text,
   * output-timeline times) to burn captions into a video export. Null when the
   * user cancels (dialog or mid-export).
   */
  exportMedia(
    videoPath: string,
    ranges: import('./edit').TimeRange[],
    kind: 'video' | 'audio',
    burnInSrt?: string
  ): Promise<{ outPath: string } | null>
  /** Save dialog + write an SRT sidecar. Null when the user cancels. */
  exportCaptions(videoPath: string, srt: string): Promise<{ outPath: string } | null>
  cancelExport(): Promise<void>
  /** Current export completion in [0,1]. Polled (not pushed) so it survives renderer reloads. */
  getExportProgress(): Promise<number>
  revealFile(path: string): Promise<void>
}
