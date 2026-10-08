'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Shell, useMe } from '@/components/Shell';
import { api, can, CaseSummary, ThreadDetail, ThreadSummary } from '@/lib/api';

const LINK_LABELS: Record<string, string> = {
  reference: 'rattaché par la référence citée',
  contact: 'rattaché par le contact',
  manual: 'classé à la main',
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function Inbox() {
  const me = useMe();
  const [filter, setFilter] = useState<'unclassified' | 'all'>('unclassified');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selected, setSelected] = useState<ThreadDetail | null>(null);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const load = useCallback(
    () =>
      run(async () => {
        const params = new URLSearchParams({ filter });
        if (query) params.set('q', query);
        setThreads(await api<ThreadSummary[]>(`/emails/threads?${params}`));
      }),
    [run, filter, query],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (can(me, 'cases', 'read')) run(async () => setCases(await api<CaseSummary[]>('/cases?status=OPEN')));
  }, [me, run]);

  const open = (id: string) => run(async () => setSelected(await api<ThreadDetail>(`/emails/threads/${id}`)));

  const classify = (caseId: string | null) =>
    selected &&
    run(async () => {
      await api(`/emails/threads/${selected.id}`, { method: 'PATCH', body: { caseId } });
      await Promise.all([open(selected.id), load()]);
    });

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    setQuery(search.trim());
  };

  return (
    <>
      <h1>E-mails</h1>
      <p className="subtitle">Tous les e-mails de vos boîtes, rattachés automatiquement aux contacts et aux dossiers.</p>
      {error && <p className="error">{error}</p>}
      <div className="row" style={{ marginBottom: 12 }}>
        <button className={filter === 'unclassified' ? 'primary' : ''} onClick={() => setFilter('unclassified')}>
          À classer
        </button>
        <button className={filter === 'all' ? 'primary' : ''} onClick={() => setFilter('all')}>
          Tous
        </button>
        <form onSubmit={submitSearch} className="row">
          <input placeholder="Rechercher (objet, expéditeur, texte)" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 280 }} />
        </form>
      </div>
      <div className="grid inbox">
        <div className="panel">
          {threads.length === 0 && <p className="muted">Aucun e-mail.</p>}
          <ul className="list">
            {threads.map((t) => {
              const last = t.messages[0];
              return (
                <li key={t.id} className={selected?.id === t.id ? 'selected' : ''} onClick={() => open(t.id)}>
                  <div style={{ minWidth: 0 }}>
                    <div className="ellipsis">
                      <strong>{last?.direction === 'OUTBOUND' ? `À : ${t.contact?.email ?? '…'}` : (last?.fromName ?? last?.fromEmail)}</strong>
                    </div>
                    <div className="ellipsis">{t.subject}</div>
                    <div className="muted ellipsis">{t.case ? `${t.case.reference} · ${t.case.title}` : last?.snippet}</div>
                  </div>
                  <span className="muted nowrap">
                    {last && formatDate(last.sentAt)}
                    {t._count.messages > 1 ? ` (${t._count.messages})` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="panel">
          {!selected ? (
            <p className="muted">Sélectionnez un e-mail.</p>
          ) : (
            <>
              <h2>{selected.subject}</h2>
              <p className="muted">
                Boîte de {selected.owner.fullName}
                {selected.contact &&
                  ` · contact : ${selected.contact.fullName ?? selected.contact.email}${selected.contact.clientAccount ? ` (${selected.contact.clientAccount.name})` : ''}`}
              </p>
              <div className="row classify">
                <span>Dossier :</span>
                {can(me, 'emails', 'update') && cases.length > 0 ? (
                  <select value={selected.case?.id ?? ''} onChange={(e) => classify(e.target.value || null)}>
                    <option value="">À classer</option>
                    {selected.case && !cases.some((c) => c.id === selected.case!.id) && (
                      <option value={selected.case.id}>
                        {selected.case.reference} · {selected.case.title}
                      </option>
                    )}
                    {cases.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.reference} · {c.title}
                        {c.clientAccount ? ` (${c.clientAccount.name})` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <strong>{selected.case ? `${selected.case.reference} · ${selected.case.title}` : 'À classer'}</strong>
                )}
                {selected.linkedBy && <span className="muted">{LINK_LABELS[selected.linkedBy]}</span>}
              </div>
              {selected.messages.map((m) => (
                <article key={m.id} className="message">
                  <header>
                    <strong>{m.fromName ?? m.fromEmail}</strong>
                    <span className="muted"> &lt;{m.fromEmail}&gt; · {formatDate(m.sentAt)}</span>
                    <div className="muted">
                      À : {m.to.join(', ')}
                      {m.cc.length ? ` · Cc : ${m.cc.join(', ')}` : ''}
                    </div>
                  </header>
                  <pre>{m.bodyText}</pre>
                  {m.attachments.length > 0 && (
                    <div className="muted">Pièces jointes : {m.attachments.map((a) => a.filename).join(', ')}</div>
                  )}
                </article>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}

export default function EmailsPage() {
  return (
    <Shell>
      <Inbox />
    </Shell>
  );
}
