import type { Metadata } from 'next';
import { Syne, DM_Mono, Instrument_Serif } from 'next/font/google';
import './globals.css';
import { Toaster } from 'react-hot-toast';

const syne = Syne({
  subsets: ['latin'],
  variable: '--font-syne',
  weight: ['400', '500', '600', '700', '800'],
});

const dmMono = DM_Mono({
  subsets: ['latin'],
  variable: '--font-dm-mono',
  weight: ['400', '500'],
});

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  variable: '--font-instrument',
  weight: ['400'],
  style: ['normal', 'italic'],
});

export const metadata: Metadata = {
  title: 'landstack.ai — Land Intelligence Platform',
  description: 'The comp database and CMA platform built for land and ranch brokers.',
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${syne.variable} ${dmMono.variable} ${instrumentSerif.variable}`}>
      <head>
        <link
          href="https://api.mapbox.com/mapbox-gl-js/v3.5.0/mapbox-gl.css"
          rel="stylesheet"
        />
        <link
          href="https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-draw/v1.5.0/mapbox-gl-draw.css"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans bg-cream text-ink antialiased">
        {children}
        {/* Toast notifications — branded warm dark with frosted blur.
            Same surface system as the map popups + sidebar (chrome
            elements that float over content). Icons use the brand
            accent variants for dark surfaces: olive-light for success,
            warm brick red for error. */}
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: 'rgba(26, 24, 21, 0.92)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              color: '#F5F1E8',
              border: '1px solid rgba(58, 52, 46, 0.7)',
              borderRadius: '10px',
              fontFamily: 'Syne, sans-serif',
              fontSize: '13px',
              fontWeight: 500,
              padding: '10px 14px',
              boxShadow: '0 12px 36px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.2)',
            },
            success: {
              iconTheme: { primary: '#A8B57A', secondary: '#1A1815' },
            },
            error: {
              iconTheme: { primary: '#C8503F', secondary: '#1A1815' },
            },
          }}
        />
      </body>
    </html>
  );
}
