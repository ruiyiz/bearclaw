// Native streaming proxy for SSE. The default Next.js rewrites buffer
// text/event-stream because the internal fetch-based proxy waits on the
// full response body in many cases. We pipe the upstream body directly
// to the client as a ReadableStream so events fan out in real time.
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BACKEND =
  process.env.NANOCLAW_BACKEND_URL ||
  `http://${process.env.NANOCLAW_HTTP_HOST || '127.0.0.1'}:${
    process.env.NANOCLAW_HTTP_PORT || '7878'
  }`;

export async function GET(req: NextRequest) {
  const upstreamUrl = `${BACKEND}/api/user/chat/stream${req.nextUrl.search}`;

  // Bridge client disconnect to upstream abort so the backend's res.on('close')
  // fires promptly and the broker drops the stale listener. Without this the
  // upstream fetch keeps the socket open after the browser closes its tab.
  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort(), { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        cookie: req.headers.get('cookie') ?? '',
        accept: 'text/event-stream',
      },
      signal: abort.signal,
      // @ts-expect-error — Node fetch flag, missing from DOM lib types.
      duplex: 'half',
    });
  } catch (err) {
    return new Response(`upstream error: ${String(err)}`, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  }

  // Re-emit the upstream readable as a new stream so we can hook the cancel
  // callback (browser close) to the upstream abort controller. ReadableStream
  // pipe-through alone doesn't propagate cancel reliably in undici.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = upstream.body!.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      };
      void pump();
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
