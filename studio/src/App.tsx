import { useEffect, useState } from 'react';
import { History } from './pages/History';
import { JobDetailPage } from './pages/JobDetail';
import { Library } from './pages/Library';
import { NewJob } from './pages/NewJob';
import { SettingsPage } from './pages/Settings';

function useHashRoute(): string {
  const [route, setRoute] = useState(() => location.hash.replace(/^#/, '') || '/library');
  useEffect(() => {
    const on = () => setRoute(location.hash.replace(/^#/, '') || '/library');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

const NAV = [
  { href: '#/library', label: 'Library SFX', match: (r: string) => r.startsWith('/library') || r.startsWith('/sfx') },
  { href: '#/new', label: 'Job Baru', match: (r: string) => r.startsWith('/new') },
  { href: '#/history', label: 'Riwayat', match: (r: string) => r.startsWith('/history') || r.startsWith('/jobs') },
  { href: '#/settings', label: 'Pengaturan', match: (r: string) => r.startsWith('/settings') },
];

export function App() {
  const route = useHashRoute();
  let page = <History />;
  if (route.startsWith('/library')) page = <Library />;
  else if (route.startsWith('/new')) page = <NewJob />;
  else if (route.startsWith('/jobs/')) page = <JobDetailPage id={route.slice('/jobs/'.length)} />;
  else if (route.startsWith('/settings')) page = <SettingsPage />;

  return (
    <div className="app">
      <nav className="side">
        <div className="brand">
          <span className="a">Auto</span>
          <span className="b">Timing</span>
          <span className="c">SFX</span>
        </div>
        {NAV.map((n) => (
          <a key={n.href} href={n.href} className={n.match(route) ? 'on' : ''}>
            {n.label}
          </a>
        ))}
        <div className="spacer" />
        <div className="foot">studio v0.1 · port 5188</div>
      </nav>
      <main>{page}</main>
    </div>
  );
}
