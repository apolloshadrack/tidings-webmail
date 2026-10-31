import { useEffect } from 'react';
import { onAuthLost, setCsrf } from './api/client';
import { Login } from './components/Login';
import { Shell } from './components/Shell';
import { queryClient, useConfig, useSession } from './state/queries';
import { setBrandAccent, useSettings } from './state/settings';

export function App() {
  const config = useConfig();
  const session = useSession();
  const hydrate = useSettings((s) => s.hydrate);

  useEffect(() => {
    if (session.data) {
      setCsrf(session.data.csrf);
      hydrate(session.data.settings);
    }
  }, [session.data, hydrate]);

  useEffect(
    () =>
      onAuthLost(() => {
        void queryClient.invalidateQueries({ queryKey: ['session'] });
      }),
    [],
  );

  useEffect(() => setBrandAccent(config.data?.brand.accent), [config.data?.brand.accent]);

  useEffect(() => {
    const css = config.data?.brand.customCss;
    if (!css) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'custom.css';
    document.head.appendChild(link);
    return () => link.remove();
  }, [config.data?.brand.customCss]);

  if (config.isLoading || session.isLoading) return <Boot />;
  if (!session.data) return <Login config={config.data} />;
  return <Shell session={session.data} config={config.data} />;
}

function Boot() {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center' }} aria-busy="true" aria-label="Loading">
      <div className="brand-mark" style={{ width: 40, height: 40, borderRadius: 12, opacity: 0.85 }} />
    </div>
  );
}
