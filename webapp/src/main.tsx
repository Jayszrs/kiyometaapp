import React from 'react'
import ReactDOM from 'react-dom/client'
import AuthGate from './AuthGate'
import './index.css'
import { GlobalLoadingDialog } from './components/LoadingDialog'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GlobalLoadingDialog />
    <AuthGate />
  </React.StrictMode>,
)
