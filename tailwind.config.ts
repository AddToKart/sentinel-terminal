import type { Config } from 'tailwindcss'

export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        sentinel: {
          ink: '#0a1116',
          slate: '#101920',
          steel: '#1d2a36',
          mist: '#8fa5b8',
          accent: '#46d6b6',
          ice: '#6da9ff',
          glow: '#a7ffef'
        }
      },
      boxShadow: {
        terminal: '0 18px 60px rgba(0, 0, 0, 0.42)',
        focus: '0 0 0 1px rgba(70, 214, 182, 0.5), 0 10px 30px rgba(70, 214, 182, 0.18)'
      },
      fontFamily: {
        sans: ['Segoe UI Variable', 'IBM Plex Sans', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'monospace']
      },
      backgroundImage: {
        noise:
          'radial-gradient(circle at top left, rgba(109, 169, 255, 0.18), transparent 34%), radial-gradient(circle at 85% 12%, rgba(70, 214, 182, 0.16), transparent 28%), linear-gradient(180deg, rgba(5, 10, 16, 0.96), rgba(3, 6, 10, 1))'
      }
    }
  },
  plugins: []
} satisfies Config
