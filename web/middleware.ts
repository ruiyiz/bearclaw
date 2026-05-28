import { NextResponse, type NextRequest } from 'next/server';

// Gate every page on the presence of the nc_session cookie. The HTTP backend
// is the source of truth and re-verifies the signature on every API call;
// this middleware just keeps unauthenticated traffic from rendering the app
// shell and getting 401s back from the API.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/login') return NextResponse.next();
  if (pathname.startsWith('/api/auth/')) return NextResponse.next();
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
