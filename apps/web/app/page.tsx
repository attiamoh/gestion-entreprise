'use client';

import { Shell, useMe } from '@/components/Shell';

const SCOPE_LABELS: Record<string, string> = {
  ALL: 'toutes les sociétés',
  COMPANY: 'sa société',
  DEPARTMENT: 'son département',
  OWN: 'ses propres données',
};

const MODULES: [string, string][] = [
  ['emails', 'E-mails'],
  ['cases', 'Dossiers'],
  ['tasks', 'Tâches et projets'],
  ['crm', 'Suivi commercial'],
  ['hr', 'Ressources humaines'],
  ['accounting', 'Comptabilité'],
];

function Today() {
  const me = useMe();
  if (!me) return null;
  return (
    <>
      <h1>Ma journée</h1>
      <p className="subtitle">
        Les e-mails à traiter, tâches du jour et dossiers récents apparaîtront ici au fil des modules livrés.
      </p>
      <div className="panel">
        <h2>Vos accès</h2>
        <div className="cards">
          {MODULES.map(([key, label]) => {
            const scope = me.permissions[key]?.read;
            return (
              <div key={key} className="panel">
                <strong>{label}</strong>
                <div className="muted">{scope ? `Lecture sur ${SCOPE_LABELS[scope]}` : 'Pas d’accès'}</div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

export default function Home() {
  return (
    <Shell>
      <Today />
    </Shell>
  );
}
