/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        primary:   { DEFAULT: '#42A5F5', 50:'#E3F2FD', 100:'#BBDEFB', 200:'#90CAF9', 300:'#64B5F6', 400:'#42A5F5', 500:'#2196F3', 600:'#1E88E5', 700:'#1976D2', 800:'#1565C0', 900:'#0D47A1' },
        secondary: { DEFAULT: '#7ED957', 50:'#F1FBE9', 100:'#DDFAC1', 200:'#C2F594', 300:'#A7F067', 400:'#7ED957', 500:'#6BC847', 600:'#56A838', 700:'#41862A', 800:'#2E641E', 900:'#1B4212' },
      },
      fontFamily: {
        display: ['Space Grotesk', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace']
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        slideUp: { from: { opacity: 0, transform: 'translateY(20px)' }, to: { opacity: 1, transform: 'translateY(0)' } }
      }
    }
  },
  plugins: []
};
