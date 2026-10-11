import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, run `npx wrangler pages dev dist` alongside and proxy the API to it.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8788' } },
})
