import { Action, Module, ScopeName } from './catalog';

type Perm = { module: Module; action: Action; scope: ScopeName };

const each = (modules: Module[], actions: Action[], scope: ScopeName): Perm[] =>
  modules.flatMap((module) => actions.map((action) => ({ module, action, scope })));

const ALL_MODULES: Module[] = ['companies', 'departments', 'users', 'roles', 'emails', 'cases', 'tasks', 'crm', 'hr', 'accounting', 'audit'];
const WORK_MODULES: Module[] = ['emails', 'cases', 'tasks', 'crm'];

/** Rôles livrés avec l'application. Les profils personnalisés s'ajoutent depuis l'écran des rôles. */
export const SYSTEM_ROLES: { name: string; description: string; isSystem: boolean; permissions: Perm[] }[] = [
  {
    name: 'Directeur Général',
    description: 'Visibilité totale sur toutes les sociétés et tous les modules, validation et export.',
    isSystem: true,
    permissions: each(ALL_MODULES, ['read', 'export', 'approve'], 'ALL'),
  },
  {
    name: 'Administrateur',
    description: 'Gère les départements, les utilisateurs et les attributions de rôles de sa société.',
    isSystem: true,
    permissions: [
      ...each(['companies'], ['read', 'update'], 'COMPANY'),
      ...each(['departments'], ['read', 'create', 'update', 'delete'], 'COMPANY'),
      ...each(['users'], ['read', 'create', 'update'], 'COMPANY'),
      ...each(['roles'], ['read', 'update'], 'COMPANY'),
      ...each(['audit'], ['read'], 'COMPANY'),
    ],
  },
  {
    name: 'Responsable de département',
    description: 'Pilote son département et ses sous-départements.',
    isSystem: true,
    permissions: [
      ...each(['companies'], ['read'], 'OWN'),
      ...each(['departments'], ['read', 'create', 'update'], 'DEPARTMENT'),
      ...each(['users'], ['read'], 'DEPARTMENT'),
      ...each(WORK_MODULES, ['read', 'create', 'update', 'approve'], 'DEPARTMENT'),
      ...each(['hr'], ['read', 'approve'], 'DEPARTMENT'),
    ],
  },
  {
    name: 'Collaborateur',
    description: 'Travaille sur ses propres dossiers, tâches et e-mails ; voit l’annuaire de sa société.',
    isSystem: true,
    permissions: [
      ...each(['companies', 'departments'], ['read'], 'OWN'),
      ...each(['users'], ['read'], 'COMPANY'),
      ...each(WORK_MODULES, ['read', 'create', 'update'], 'OWN'),
    ],
  },
  {
    name: 'Comptable',
    description: 'Exemple de profil personnalisé : comptabilité complète, CRM en lecture.',
    isSystem: false,
    permissions: [
      ...each(['accounting'], ['read', 'create', 'update', 'delete', 'export', 'approve'], 'COMPANY'),
      ...each(['crm'], ['read'], 'COMPANY'),
      ...each(['companies'], ['read'], 'OWN'),
    ],
  },
  {
    name: 'Ressources humaines',
    description: 'Exemple de profil personnalisé : module RH complet et annuaire.',
    isSystem: false,
    permissions: [
      ...each(['hr'], ['read', 'create', 'update', 'delete', 'export', 'approve'], 'COMPANY'),
      ...each(['users'], ['read'], 'COMPANY'),
      ...each(['companies', 'departments'], ['read'], 'COMPANY'),
    ],
  },
];
