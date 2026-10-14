import React from 'react'
import ReactDOM from 'react-dom/client'
import AuthGate from './AuthGate'
import './index.css'
import { GlobalLoadingDialog } from './components/LoadingDialog'

// Production HTTPS/localhost builds cache all page chunks, so a previously
// opened tablet app can reopen its draft screens without a connection.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/offline-sw.js').catch(error => console.warn('Offline app shell unavailable', error));
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GlobalLoadingDialog />
    <AuthGate />
  </React.StrictMode>,
)
