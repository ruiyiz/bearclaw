import type { NextConfig } from 'next';
import path from 'node:path';

const backend =
  process.env.NANOCLAW_BACKEND_URL ||
  `http://${process.env.NANOCLAW_HTTP_HOST || '127.0.0.1'}:${
    process.env.NANOCLAW_HTTP_PORT || '7878'
  }`;

const config: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname, '..'),
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${backend}/api/:path*` }];
  },
  // PWA support — service worker is served as a static asset out of /public.
  headers: async () => [
    {
      source: '/sw.js',
      headers: [
        { key: 'cache-control', value: 'no-cache, no-store, must-revalidate' },
        { key: 'service-worker-allowed', value: '/' },
      ],
    },
  ],
};

export default config;
