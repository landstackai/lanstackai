/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        night: '#0b0f14',
        navy: '#111827',
        panel: '#161d27',
        card: '#1e2736',
        border: '#2a3547',
        sage: '#34d399',
        'sage-2': '#10b981',
        'sage-3': '#059669',
        gold: '#f59e0b',
        // ─── Light-theme palette (vault page) ───────────────────────────
        // Warm, editorial palette inspired by Claude.ai's cream + accent
        // restraint. Single-source token system so palette tweaks (shade,
        // saturation) edit one file — not every className across the app.
        //
        // The pairing of cream + olive is intentional for a land brokerage
        // tool: cream reads "expensive notebook / Italian luxury"; olive
        // reads "rangeland / agriculture / patient capital." Together they
        // signal seriousness without resorting to corporate blue-and-gray.
        cream: '#FAF8F2',         // page background — warm off-white
        'cream-2': '#F3EFE3',     // optional secondary surface (header zones)
        ink: '#1F1F1C',           // primary text — warm black, not pure black
        'ink-2': '#6B6960',       // secondary text — labels, subtitles
        'ink-3': '#9C9A8F',       // tertiary text — placeholders, em-dash fills
        beige: '#E8E5DD',         // hairline borders
        'beige-2': '#DAD5C7',     // stronger borders / dividers
        olive: '#6B7B3F',         // primary accent — pale dusty olive
        'olive-2': '#5C6B33',     // darker (hover, pressed)
        'olive-tint': '#EFF1E3',  // chip + soft fill background
        'olive-border': '#D4DAB8',// chip border (sits inside olive-tint)
        'slate-blue': '#4A6FA5',  // secondary accent (links, info badges)
        'slate-blue-2': '#3A5A8A',// darker slate blue for hover
        // iMessage blue — exact Apple system blue (#007AFF). Reserved for
        // chat-like "send" actions (the AI search "Ask" button across vault
        // + map). Universal affordance: brokers have hit this color
        // thousands of times on their phones, so they instinctively know
        // "tap this to send a message."
        imsg: '#007AFF',
        'imsg-2': '#0066D9',      // darker for hover / pressed
      },
      fontFamily: {
        sans: ['Syne', 'sans-serif'],
        mono: ['DM Mono', 'monospace'],
        serif: ['Instrument Serif', 'serif'],
      },
    },
  },
  plugins: [],
};
