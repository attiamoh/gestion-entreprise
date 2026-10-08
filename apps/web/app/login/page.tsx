'use client';

import Script from 'next/script';
import { useRouter } from 'next/navigation';
import { FormEvent, useCallback, useState } from 'react';
import { api, setToken } from '@/lib/api';

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(options: { client_id: string; callback: (r: { credential: string }) => void }): void;
          renderButton(el: HTMLElement, options: Record<string, string>): void;
        };
      };
    };
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const finish = useCallback(
    async (path: string, body: object) => {
      setError(null);
      try {
        const { accessToken } = await api<{ accessToken: string }>(path, { method: 'POST', body });
        setToken(accessToken);
        router.replace('/');
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [router],
  );

  const initGoogle = () => {
    const el = document.getElementById('google-button');
    if (!window.google || !el || !GOOGLE_CLIENT_ID) return;
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: ({ credential }) => finish('/auth/google', { idToken: credential }),
    });
    window.google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'fr' });
  };

  const devLogin = (e: FormEvent) => {
    e.preventDefault();
    finish('/auth/dev-login', { email });
  };

  return (
    <div className="login panel">
      <h1>Connexion</h1>
      <p className="subtitle">Utilisez votre compte Google professionnel.</p>
      {GOOGLE_CLIENT_ID ? (
        <>
          <Script src="https://accounts.google.com/gsi/client" onLoad={initGoogle} />
          <div id="google-button" />
        </>
      ) : (
        <p className="muted">Connexion Google non configurée (NEXT_PUBLIC_GOOGLE_CLIENT_ID).</p>
      )}
      <form className="form" onSubmit={devLogin}>
        <span className="muted">Mode développement : connexion par e-mail</span>
        <input type="email" required placeholder="prenom.nom@entreprise.ci" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="primary" type="submit">
          Se connecter
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
