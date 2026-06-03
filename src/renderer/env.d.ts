/// <reference types="vite/client" />
import type { FleetBridge } from '../shared/types'

declare global {
  interface Window {
    fleet: FleetBridge
  }
}
