import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// Fast route-level auth gate. Authorization is still enforced close to the
// data (page loaders, Route Handlers) — middleware is not the final boundary,
// it just redirects unauthenticated users before the route renders.
const isProtectedRoute = createRouteMatcher([
  '/admin(.*)',
  '/explorer(.*)',
  '/watchlist(.*)',
  '/category-builder(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ['/((?!.*\\..*|_next).*)', '/', '/(api|trpc)(.*)'],
};
