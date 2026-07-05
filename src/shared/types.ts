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

export const IPC = {
  selectVideo: 'video:select',
  extractAudio: 'audio:extract',
  apiKeyStatus: 'apiKey:status',
  apiKeySet: 'apiKey:set',
  projectLoad: 'project:load',
  transcribeStart: 'transcribe:start',
  transcribeProgress: 'transcribe:progress'
} as const

/** The API the preload script exposes to the renderer as `window.poddie`. */
export interface PoddieApi {
  selectVideo(): Promise<VideoInfo | null>
  extractAudio(videoPath: string): Promise<AudioExtractResult>
  getApiKeyStatus(): Promise<ApiKeyStatus>
  setApiKey(key: string): Promise<ApiKeyStatus>
  loadProject(videoPath: string): Promise<Project | null>
  /** Resolves to null when the user cancels the cost-confirmation dialog. */
  transcribe(videoPath: string): Promise<Project | null>
  /** Subscribe to transcription progress; returns an unsubscribe function. */
  onTranscribeProgress(cb: (p: TranscribeProgress) => void): () => void
}
