import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import './index.css';
import { I18nProvider } from './i18n/index.tsx';
import { ThemeProvider } from './lib/theme.tsx';
import { AppShell } from './components/AppShell.tsx';
import { NewRunPage } from './pages/NewRunPage.tsx';
import { RunsPage } from './pages/RunsPage.tsx';
import { RunDetailPage } from './pages/run/RunDetailPage.tsx';
import { ExperimentsPage } from './pages/ExperimentsPage.tsx';
import { ExperimentDetailPage } from './pages/experiment/ExperimentDetailPage.tsx';
import { SystemPage } from './pages/SystemPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <NewRunPage /> },
      { path: 'runs', element: <RunsPage /> },
      { path: 'runs/:runId', element: <RunDetailPage /> },
      { path: 'experiments', element: <ExperimentsPage /> },
      { path: 'experiments/:expId', element: <ExperimentDetailPage /> },
      { path: 'system', element: <SystemPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
