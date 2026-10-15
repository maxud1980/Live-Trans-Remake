import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { Overlay } from './components/Overlay'
import './styles.css'

// One bundle, two windows: the main window and the floating subtitles window (#overlay).
const isOverlay = window.location.hash === '#overlay'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isOverlay ? <Overlay /> : <App />}</React.StrictMode>
)
