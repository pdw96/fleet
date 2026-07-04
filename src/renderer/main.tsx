import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { HydrationProvider } from './bridge/hydration'
import { initWebBridge } from './bridge/web-bridge'
import './styles.css'

// 웹 배포(preload 부재)면 ws-bridge 를 window.fleet 로 주입 — 데스크톱은 no-op(null). #197 B4.
const webBridge = initWebBridge()

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <HydrationProvider bridge={webBridge}>
        <App />
      </HydrationProvider>
    </React.StrictMode>,
  )
}
