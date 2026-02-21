/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Discord-inspired dark theme colors
        vox: {
          bg: {
            primary: '#1a1a2e',
            secondary: '#16213e',
            tertiary: '#0f3460',
            hover: '#1f2b4d',
            active: '#253356',
            floating: '#111827',
          },
          sidebar: '#12122a',
          channel: '#151530',
          chat: '#1a1a3e',
          text: {
            primary: '#e4e6eb',
            secondary: '#a0a3b1',
            muted: '#6b7089',
            link: '#5b9cf4',
          },
          accent: {
            primary: '#5b5bf7',
            hover: '#4a4ae0',
            success: '#3eba68',
            warning: '#f5a623',
            danger: '#ed4245',
            info: '#5b9cf4',
          },
          border: '#2a2a4a',
          voice: {
            connected: '#3eba68',
            speaking: '#5b5bf7',
            muted: '#ed4245',
          },
        },
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.5s ease-out infinite',
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.2s ease-out',
      },
      keyframes: {
        'pulse-ring': {
          '0%': { transform: 'scale(0.95)', opacity: '1' },
          '100%': { transform: 'scale(1.3)', opacity: '0' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
