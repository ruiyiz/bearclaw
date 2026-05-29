import './globals.css';
import 'highlight.js/styles/github-dark.css';
import type { Metadata, Viewport } from 'next';
import {
  Geist,
  IBM_Plex_Sans,
  Inter,
  Lora,
  Manrope,
  Source_Serif_4,
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
const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-source-serif',
  display: 'swap',
});
const lora = Lora({
  subsets: ['latin'],
  variable: '--font-lora',
  display: 'swap',
});

const fontVars = [geist, spaceGrotesk, inter, manrope, plex, sourceSerif, lora]
  .map((f) => f.variable)
  .join(' ');

export const metadata: Metadata = {
  title: 'BearClaw',
  description: 'Personal Claude assistant',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'BearClaw',
  },
  icons: {
    icon: [{ url: '/logo.png', type: 'image/png' }],
    shortcut: '/logo.png',
    apple: '/icons/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b0d10',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// Apply saved theme before paint so the page doesn't flash. Chat-only font +
// size are applied on body after <body> exists, because the next/font
// `--font-*` CSS variables are scoped to <body>.
const HEAD_BOOT_SCRIPT = `try{var t=localStorage.getItem('nc.theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}`;
const BODY_BOOT_SCRIPT = `try{var v=localStorage.getItem('nc.font')||'geist';document.body.style.setProperty('--chat-font',"var(--font-"+v+"), ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif");var s=localStorage.getItem('nc.fontSize')||'md';var px={sm:13,md:14,lg:16,xl:18}[s]||14;document.body.style.setProperty('--chat-font-size',px+'px');}catch(e){}`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: HEAD_BOOT_SCRIPT }} />
      </head>
      <body className={`${fontVars} h-dvh flex flex-col overflow-hidden`}>
        <script dangerouslySetInnerHTML={{ __html: BODY_BOOT_SCRIPT }} />
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
