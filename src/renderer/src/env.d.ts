import type { PoddieApi } from '../../shared/types'

declare global {
  interface Window {
    poddie: PoddieApi
  }
}

export {}
