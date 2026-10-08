/** Modules de l'application soumis au contrôle d'accès. */
export const MODULES = [
  'companies',
  'departments',
  'users',
  'roles',
  'emails',
  'cases',
  'tasks',
  'crm',
  'hr',
  'accounting',
  'audit',
] as const;
export type Module = (typeof MODULES)[number];

/** Actions contrôlées sur chaque module. */
export const ACTIONS = ['read', 'create', 'update', 'delete', 'export', 'approve'] as const;
export type Action = (typeof ACTIONS)[number];

export const SCOPES = ['OWN', 'DEPARTMENT', 'COMPANY', 'ALL'] as const;
export type ScopeName = (typeof SCOPES)[number];

export const MODULE_LABELS: Record<Module, string> = {
  companies: 'Sociétés',
  departments: 'Départements',
  users: 'Utilisateurs',
  roles: 'Rôles et permissions',
  emails: 'E-mails',
  cases: 'Dossiers',
  tasks: 'Tâches et projets',
  crm: 'CRM / suivi commercial',
  hr: 'Ressources humaines',
  accounting: 'Comptabilité',
  audit: "Journal d'audit",
};

export function isModule(value: string): value is Module {
  return (MODULES as readonly string[]).includes(value);
}

export function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}
