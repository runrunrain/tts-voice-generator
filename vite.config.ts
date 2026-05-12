import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

const DEFAULT_BACKEND_PORT = 3001
const MIN_PORT = 1
const MAX_PORT = 65535

function parseBackendPort(rawValue: string | undefined): number {
  const trimmedValue = rawValue?.trim()
  if (!trimmedValue) {
    return DEFAULT_BACKEND_PORT
  }

  const parsed = Number.parseInt(trimmedValue, 10)
  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== trimmedValue ||
    parsed < MIN_PORT ||
    parsed > MAX_PORT
  ) {
    console.warn(`[vite] Ignoring invalid BACKEND_PORT; using ${DEFAULT_BACKEND_PORT}.`)
    return DEFAULT_BACKEND_PORT
  }

  return parsed
}

function resolveDevProxyTarget(): string {
  const explicitTarget = process.env.VITE_DEV_SERVER_PROXY_TARGET?.trim()
  if (explicitTarget) {
    try {
      const parsedTarget = new URL(explicitTarget)
      if (parsedTarget.protocol === 'http:' || parsedTarget.protocol === 'https:') {
        return parsedTarget.origin
      }
    } catch {
      // Fall through to the BACKEND_PORT-derived default target.
    }

    console.warn('[vite] Ignoring invalid VITE_DEV_SERVER_PROXY_TARGET; using BACKEND_PORT/default target.')
  }

  return `http://127.0.0.1:${parseBackendPort(process.env.BACKEND_PORT)}`
}

const devProxyTarget = resolveDevProxyTarget()

export default defineConfig({
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // Dev server proxy: forward /api/* to backend Hono server
  server: {
    proxy: {
      '/api': {
        target: devProxyTarget,
        changeOrigin: true,
      },
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],
})
