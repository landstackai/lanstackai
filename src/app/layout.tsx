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
      </head>
      <body className="font-sans bg-night text-white antialiased">
        {children}
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: '#1e2736',
              color: '#f1f5f9',
              border: '1px solid #2a3547',
              fontFamily: 'Syne, sans-serif',
              fontSize: '13px',
            },
            success: {
              iconTheme: { primary: '#34d399', secondary: '#0b0f14' },
            },
            error: {
              iconTheme: { primary: '#ef4444', secondary: '#0b0f14' },
            },
          }}
        />
      </body>
    </html>
  );
}
