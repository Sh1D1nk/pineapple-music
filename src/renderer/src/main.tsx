import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@applemusic-like-lyrics/core/style.css'
import './styles/tokens.css'
import './styles/base.css'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
