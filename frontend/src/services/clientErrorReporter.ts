import { apiUrl } from './apiClient'

let installed = false

export function sendClientErrorLog(params: {
  category: string
  message: string
  childId?: string | null
  stack?: string | null
  extra?: Record<string, unknown>
}): void {
  const body = JSON.stringify({
    childId: params.childId ?? null,
    category: params.category,
    message: params.message.slice(0, 950),
    pageUrl: typeof window !== 'undefined' ? window.location.href : null,
    stack: params.stack ? params.stack.slice(0, 3800) : null,
    extra: params.extra ?? {},
  })

  fetch(apiUrl('/api/v1/logs/client-error'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined)
}

export function installGlobalClientErrorReporter(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (event) => {
    const errObj = event.error as Error | undefined
    sendClientErrorLog({
      category: 'window_error',
      message: event.message || errObj?.message || '未知前端运行错误',
      stack: errObj?.stack ?? null,
      extra: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const msg =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : JSON.stringify(reason)
    sendClientErrorLog({
      category: 'unhandled_promise',
      message: msg || '未捕获 Promise 异常',
      stack: reason instanceof Error ? (reason.stack ?? null) : null,
    })
  })
}
