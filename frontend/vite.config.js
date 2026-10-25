import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { resolveApiBaseUrl } from './src/apiBaseUrl.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const apiUrl = process.env.VITE_API_URL || env.VITE_API_URL
  if (mode === 'production') resolveApiBaseUrl(apiUrl, true)
  return {
    plugins: [react()],
  }
})
