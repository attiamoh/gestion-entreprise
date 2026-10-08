'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Shell, useMe } from '@/components/Shell';
import { api, can, Company, Department } from '@/lib/api';

function DepartmentTree({
  departments,
  parentId,
  onRename,
  onDelete,
  onAddChild,
  canEdit,
  canDelete,
}: {
  departments: Department[];
  parentId: string | null;
  onRename: (d: Department) => void;
  onDelete: (d: Department) => void;
  onAddChild: (d: Department) => void;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const ids = new Set(departments.map((d) => d.id));
  // Un département dont le parent n'est pas visible s'affiche à la racine.
  const level = departments.filter((d) => (parentId ? d.parentId === parentId : !d.parentId || !ids.has(d.parentId)));
  if (!level.length) return null;
  return (
    <ul className={parentId ? 'tree' : 'tree root'}>
      {level.map((d) => (
        <li key={d.id}>
          <div className="node">
            <div>
              <strong>{d.name}</strong>
              {d.code && <span className="muted"> · {d.code}</span>}
              <div className="muted">
                {d._count.members} membre(s){d.manager ? ` · responsable : ${d.manager.fullName}` : ''}
              </div>
            </div>
            <div className="actions">
              {canEdit && <button onClick={() => onAddChild(d)}>+ Sous-département</button>}
              {canEdit && <button onClick={() => onRename(d)}>Renommer</button>}
              {canDelete && (
                <button className="danger" onClick={() => onDelete(d)}>
                  Supprimer
                </button>
              )}
            </div>
          </div>
          <DepartmentTree
            departments={departments}
            parentId={d.id}
            onRename={onRename}
            onDelete={onDelete}
            onAddChild={onAddChild}
            canEdit={canEdit}
            canDelete={canDelete}
          />
        </li>
      ))}
    </ul>
  );
}

function CompaniesAdmin() {
  const me = useMe();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newCompany, setNewCompany] = useState({ name: '', legalForm: '', rccm: '', taxId: '' });
  const [newDept, setNewDept] = useState({ name: '', code: '', parentId: '' });

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadCompanies = useCallback(
    () =>
      run(async () => {
        const list = await api<Company[]>('/companies');
        setCompanies(list);
        setSelected((current) => current ?? list[0]?.id ?? null);
      }),
    [run],
  );

  const loadDepartments = useCallback(
    () => run(async () => (selected ? setDepartments(await api<Department[]>(`/departments?companyId=${selected}`)) : setDepartments([]))),
    [run, selected],
  );

  useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);
  useEffect(() => {
    loadDepartments();
  }, [loadDepartments]);

  const company = useMemo(() => companies.find((c) => c.id === selected), [companies, selected]);
  if (!me) return null;
  const canCreateCompany = me.isSuperAdmin || me.permissions.companies?.create === 'ALL';
  const canCreateDept = can(me, 'departments', 'create');
  const canEdit = can(me, 'departments', 'update');
  const canDelete = can(me, 'departments', 'delete');

  const createCompany = (e: FormEvent) => {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(newCompany).filter(([, v]) => v.trim()));
    run(async () => {
      const created = await api<Company>('/companies', { method: 'POST', body });
      setNewCompany({ name: '', legalForm: '', rccm: '', taxId: '' });
      setSelected(created.id);
      await loadCompanies();
    });
  };

  const createDepartment = (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    run(async () => {
      await api('/departments', {
        method: 'POST',
        body: {
          companyId: selected,
          name: newDept.name,
          ...(newDept.code ? { code: newDept.code } : {}),
          ...(newDept.parentId ? { parentId: newDept.parentId } : {}),
        },
      });
      setNewDept({ name: '', code: '', parentId: '' });
      await Promise.all([loadDepartments(), loadCompanies()]);
    });
  };

  const rename = (d: Department) => {
    const name = window.prompt('Nouveau nom du département', d.name);
    if (!name || name === d.name) return;
    run(async () => {
      await api(`/departments/${d.id}`, { method: 'PATCH', body: { name } });
      await loadDepartments();
    });
  };

  const remove = (d: Department) => {
    if (!window.confirm(`Supprimer le département « ${d.name} » ?`)) return;
    run(async () => {
      await api(`/departments/${d.id}`, { method: 'DELETE' });
      await Promise.all([loadDepartments(), loadCompanies()]);
    });
  };

  const addChild = (d: Department) => setNewDept({ name: '', code: '', parentId: d.id });

  return (
    <>
      <h1>Sociétés et départements</h1>
      <p className="subtitle">Chaque société organise librement ses départements et sous-départements.</p>
      {error && <p className="error">{error}</p>}
      <div className="grid">
        <div className="panel">
          <h2>Sociétés</h2>
          <ul className="list">
            {companies.map((c) => (
              <li key={c.id} className={c.id === selected ? 'selected' : ''} onClick={() => setSelected(c.id)}>
                <span>
                  {c.name}
                  {!c.isActive && <span className="muted"> (désactivée)</span>}
                </span>
                <span className="muted">{c._count.users} pers.</span>
              </li>
            ))}
          </ul>
          {canCreateCompany && (
            <form className="form" onSubmit={createCompany}>
              <strong>Nouvelle société</strong>
              <input required minLength={2} placeholder="Raison sociale" value={newCompany.name} onChange={(e) => setNewCompany({ ...newCompany, name: e.target.value })} />
              <input placeholder="Forme juridique (SARL, SA…)" value={newCompany.legalForm} onChange={(e) => setNewCompany({ ...newCompany, legalForm: e.target.value })} />
              <input placeholder="RCCM" value={newCompany.rccm} onChange={(e) => setNewCompany({ ...newCompany, rccm: e.target.value })} />
              <input placeholder="Compte contribuable (NCC)" value={newCompany.taxId} onChange={(e) => setNewCompany({ ...newCompany, taxId: e.target.value })} />
              <button className="primary" type="submit">
                Créer la société
              </button>
            </form>
          )}
        </div>

        <div className="panel">
          <h2>{company ? `Départements de ${company.name}` : 'Départements'}</h2>
          {company && (
            <p className="muted">
              {company.legalForm ?? 'Forme juridique non renseignée'} · {company.country} · {company.currency}
              {company.rccm ? ` · RCCM ${company.rccm}` : ''}
              {company.taxId ? ` · NCC ${company.taxId}` : ''}
            </p>
          )}
          {departments.length === 0 && <p className="muted">Aucun département visible.</p>}
          <DepartmentTree
            departments={departments}
            parentId={null}
            onRename={rename}
            onDelete={remove}
            onAddChild={addChild}
            canEdit={canEdit}
            canDelete={canDelete}
          />
          {canCreateDept && selected && (
            <form className="form" onSubmit={createDepartment}>
              <strong>Ajouter un département</strong>
              <div className="row">
                <input required minLength={2} placeholder="Nom" value={newDept.name} onChange={(e) => setNewDept({ ...newDept, name: e.target.value })} />
                <input placeholder="Code (facultatif)" value={newDept.code} onChange={(e) => setNewDept({ ...newDept, code: e.target.value })} />
                <select value={newDept.parentId} onChange={(e) => setNewDept({ ...newDept, parentId: e.target.value })}>
                  <option value="">Au premier niveau</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      Sous « {d.name} »
                    </option>
                  ))}
                </select>
                <button className="primary" type="submit">
                  Ajouter
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </>
  );
}

export default function CompaniesPage() {
  return (
    <Shell>
      <CompaniesAdmin />
    </Shell>
  );
}
