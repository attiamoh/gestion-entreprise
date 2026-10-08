'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { api, can, getToken, Me, setToken } from '@/lib/api';

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext);

/** Modules du menu ; ceux qui ne sont pas encore livrés sont affichés grisés. */
const NAV = [
  { href: '/', label: 'Ma journée', module: null, ready: true },
  { href: '/emails', label: 'E-mails', module: 'emails', ready: true },
  { href: '/dossiers', label: 'Dossiers', module: 'cases', ready: false },
  { href: '/taches', label: 'Tâches et projets', module: 'tasks', ready: false },
  { href: '/crm', label: 'Suivi commercial', module: 'crm', ready: false },
  { href: '/rh', label: 'Ressources humaines', module: 'hr', ready: false },
  { href: '/compta', label: 'Comptabilité', module: 'accounting', ready: false },
  { href: '/admin/societes', label: 'Sociétés et départements', module: 'departments', ready: true },
];

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    api<Me>('/auth/me').then(setMe).catch(() => router.replace('/login'));
  }, [router]);

  if (!me) return <div className="loading">Chargement…</div>;

  const logout = () => {
    setToken(null);
    router.replace('/login');
  };

  return (
    <MeContext.Provider value={me}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">Gestion entreprise</div>
          <nav>
            {NAV.filter((item) => !item.module || can(me, item.module, 'read')).map((item) =>
              item.ready ? (
                <Link key={item.href} href={item.href} className={pathname === item.href ? 'active' : ''}>
                  {item.label}
                </Link>
              ) : (
                <span key={item.href} className="soon" title="Bientôt disponible">
                  {item.label}
                </span>
              ),
            )}
          </nav>
          <div className="whoami">
            <div>{me.email}</div>
            {me.isSuperAdmin && <div className="badge">Super admin</div>}
            <button className="link" onClick={logout}>
              Se déconnecter
            </button>
          </div>
        </aside>
        <main className="content">{children}</main>
      </div>
    </MeContext.Provider>
  );
}
