import './globals.css';
import type { Metadata, Viewport } from 'next';
import { ServiceWorkerRegister } from './sw-register';

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen h-dvh flex flex-col">
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
