import './globals.css';
import 'highlight.js/styles/github-dark.css';
import type { Metadata, Viewport } from 'next';
import {
  Geist,
  IBM_Plex_Sans,
  Inter,
  Manrope,
  Space_Grotesk,
} from 'next/font/google';
import { ServiceWorkerRegister } from './sw-register';

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space',
  display: 'swap',
});
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});
const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-manrope',
  display: 'swap',
});
const plex = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex',
  display: 'swap',
});

const fontVars = [geist, spaceGrotesk, inter, manrope, plex]
  .map((f) => f.variable)
  .join(' ');

export const metadata: Metadata = {
  title: 'NanoClaw',
  description: 'Personal Claude assistant',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'NanoClaw',
  },
  icons: {
    icon: [
      { url: '/icons/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b0d10',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// Apply saved font choice before paint so the page doesn't flash with the
// default font and then re-flow when the client effect catches up.
const FONT_BOOT_SCRIPT = `try{var v=localStorage.getItem('nc.font');if(v){document.documentElement.style.setProperty('--app-font','var(--font-'+v+')');}}catch(e){}`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: FONT_BOOT_SCRIPT }} />
      </head>
      <body className={`${fontVars} h-dvh flex flex-col overflow-hidden`}>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
