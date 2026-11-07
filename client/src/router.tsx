import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import App from './App';

/**
 * Route hierarchy mirrors the app's data hierarchy:
 *
 *   /                       -> shell with no project (onboarding / redirect)
 *   /$projectId            -> shell, project selected, no session open
 *   /$projectId/$sessionId -> shell, project + session open

 *
 * All three render the same shell (App); the nested routes exist so the
 * URL carries the project/session selection and the shell reads it via
 * useParams() (branch params accumulate down the matched branch).
 */
const rootRoute = createRootRoute({ component: App });

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$projectId',
  component: () => null,
});

const sessionRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/$sessionId',
  component: () => null,
});

const routeTree = rootRoute.addChildren([projectRoute.addChildren([sessionRoute])]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />;
}
