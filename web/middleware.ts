import { NextResponse, type NextRequest } from 'next/server';

const BACKEND =
  process.env.BEARCLAW_BACKEND_URL ||
  `http://${process.env.BEARCLAW_HTTP_HOST || '127.0.0.1'}:${
    process.env.BEARCLAW_HTTP_PORT || '7878'
  }`;

// A finished install is cached for half a minute; an unfinished one for barely
// any time, so the redirect to /setup lifts as soon as the wizard is done.
const ONBOARDED_TTL_MS = 30_000;
const PENDING_TTL_MS = 1_500;

let cached: { onboarded: boolean; at: number } | null = null;

// A fresh install has no password, so the cookie gate would bounce the owner to
// a login they cannot pass. Ask the backend once every 30 s whether onboarding
// is done. A backend that is down counts as onboarded: the wizard is not the
// right answer to an outage, and pretending otherwise would brick the app.
async function isOnboarded(): Promise<boolean> {
  const ttl = cached?.onboarded ? ONBOARDED_TTL_MS : PENDING_TTL_MS;
  if (cached && Date.now() - cached.at < ttl) return cached.onboarded;
  let onboarded = true;
  try {
    const res = await fetch(`${BACKEND}/api/setup/status`, {
      cache: 'no-store',
    });
    if (res.ok) {
      const body = (await res.json()) as { onboarded?: boolean };
      onboarded = body.onboarded !== false;
    }
  } catch {
    onboarded = true;
  }
  cached = { onboarded, at: Date.now() };
  return onboarded;
}

// Gate every page on the presence of the nc_session cookie. The HTTP backend
// is the source of truth and re-verifies the signature on every API call;
// this middleware just keeps unauthenticated traffic from rendering the app
// shell and getting 401s back from the API.
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const onboarded = await isOnboarded();

  if (!onboarded) {
    // Only pages are herded to the wizard. API traffic passes through — the
    // backend still enforces its own auth, and the wizard needs it.
    if (pathname === '/setup' || pathname.startsWith('/api/')) {
      return NextResponse.next();
    }
    const url = req.nextUrl.clone();
    url.pathname = '/setup';
    url.search = '';
    return NextResponse.redirect(url);
  }

  // Once onboarding is done the wizard is an owner-only page: an anonymous
  // visitor must not even learn it exists.
  if (pathname === '/setup' && !req.cookies.get('nc_session')) {
    return new NextResponse(null, { status: 404 });
  }

  if (pathname === '/login') return NextResponse.next();
  if (pathname.startsWith('/api/auth/')) return NextResponse.next();
  if (pathname.startsWith('/api/setup/')) return NextResponse.next();
  // Webhook triggers and one-shot approval links carry their own token.
  if (pathname.startsWith('/api/hooks/')) return NextResponse.next();
  if (pathname.startsWith('/r/')) return NextResponse.next();
  if (req.cookies.get('nc_session')) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Skip _next/* assets, static files, /api/auth/* (handled above), and the
  // PWA manifest/icons/sw.
  matcher: [
    '/((?!_next/|icons/|sw\\.js|manifest\\.webmanifest|favicon\\.ico|icon\\.png|apple-icon\\.png|logo\\.png).*)',
  ],
};
