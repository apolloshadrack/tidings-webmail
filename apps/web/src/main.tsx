import '@fontsource-variable/inter';
import './styles/app.css';
import './styles/settings.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { queryClient } from './state/queries';
import { applyAppearance, settings } from './state/settings';

applyAppearance(settings());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

if (import.meta.env.DEV) {
  void import('./state/ui').then(({ useUi }) => {
    (window as unknown as { __tidings: unknown }).__tidings = { useUi };
  });
}
