import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AdminConsoleApp } from './admin/AdminConsoleApp'
import { App } from './App'
import { installGlobalClientErrorReporter } from './services/clientErrorReporter'

installGlobalClientErrorReporter()

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Root container #root is missing in index.html')
}

const isAdminRoute =
  typeof window !== 'undefined' &&
  (window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/'))

createRoot(rootEl).render(
  <StrictMode>{isAdminRoute ? <AdminConsoleApp /> : <App />}</StrictMode>,
)
