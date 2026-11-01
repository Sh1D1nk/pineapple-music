import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@applemusic-like-lyrics/core/style.css'
import './styles/tokens.css'
import './styles/base.css'
import { App } from './App'
import { CloseDialog } from './overlays/CloseDialog'
import { TrayMenu } from './overlays/TrayMenu'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing')

// 独立浮窗（关闭确认 / 托盘菜单）复用同一个 bundle，用 query 分流
const params = new URLSearchParams(window.location.search)
const overlay = params.get('overlay')
const dark = params.get('dark') === '1'

createRoot(container).render(
  <StrictMode>
    {overlay === 'close' ? (
      <CloseDialog dark={dark} />
    ) : overlay === 'tray' ? (
      <TrayMenu dark={dark} />
    ) : (
      <App />
    )}
  </StrictMode>
)
