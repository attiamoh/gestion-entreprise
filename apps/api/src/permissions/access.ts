import { Action, Module, ScopeName } from './catalog';

export interface Grant {
  module: string;
  action: string;
  scope: ScopeName;
  /** Société à laquelle le rôle est limité ; null = société de l'utilisateur. */
  companyId: string | null;
}

/** Utilisateur connecté, avec tout ce qu'il faut pour décider de ses accès. */
export interface Principal {
  id: string;
  email: string;
  isSuperAdmin: boolean;
  companyId: string | null;
  departmentId: string | null;
  /** Son département et tous ses sous-départements. */
  departmentIds: string[];
  grants: Grant[];
}

/** Données accessibles pour un couple module/action. */
export type Access =
  | { kind: 'none' }
  | { kind: 'all' }
  | { kind: 'scoped'; companyIds: string[]; departmentIds: string[]; ownerId: string | null };

const RANK: Record<ScopeName, number> = { OWN: 0, DEPARTMENT: 1, COMPANY: 2, ALL: 3 };

/** Combine toutes les attributions de l'utilisateur pour un module et une action. */
export function resolveAccess(principal: Principal, module: Module, action: Action): Access {
  if (principal.isSuperAdmin) return { kind: 'all' };

  const grants = principal.grants.filter((g) => g.module === module && g.action === action);
  if (grants.length === 0) return { kind: 'none' };
  if (grants.some((g) => g.scope === 'ALL')) return { kind: 'all' };

  const companyIds = new Set<string>();
  const departmentIds = new Set<string>();
  let ownerId: string | null = null;

  for (const grant of grants) {
    if (grant.scope === 'COMPANY') {
      const companyId = grant.companyId ?? principal.companyId;
      if (companyId) companyIds.add(companyId);
    } else if (grant.scope === 'DEPARTMENT') {
      principal.departmentIds.forEach((id) => departmentIds.add(id));
      ownerId = principal.id;
    } else if (grant.scope === 'OWN') {
      ownerId = principal.id;
    }
  }

  if (companyIds.size === 0 && departmentIds.size === 0 && ownerId === null) {
    return { kind: 'none' };
  }
  return { kind: 'scoped', companyIds: [...companyIds], departmentIds: [...departmentIds], ownerId };
}

/** Portée la plus large accordée, utile pour l'affichage. */
export function widestScope(principal: Principal, module: Module, action: Action): ScopeName | null {
  if (principal.isSuperAdmin) return 'ALL';
  const scopes = principal.grants
    .filter((g) => g.module === module && g.action === action)
    .map((g) => g.scope);
  if (scopes.length === 0) return null;
  return scopes.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/** Champs d'une entité qui portent la société, le département et le propriétaire. */
export interface ScopeFields {
  company?: string;
  department?: string;
  owner?: string;
}

/**
 * Traduit un accès en filtre Prisma pour une entité.
 * Renvoie null quand rien n'est accessible.
 */
export function scopeWhere(access: Access, fields: ScopeFields): Record<string, unknown> | null {
  if (access.kind === 'none') return null;
  if (access.kind === 'all') return {};

  const or: Record<string, unknown>[] = [];
  if (fields.company && access.companyIds.length) {
    or.push({ [fields.company]: { in: access.companyIds } });
  }
  if (fields.department && access.departmentIds.length) {
    or.push({ [fields.department]: { in: access.departmentIds } });
  }
  if (fields.owner && access.ownerId) {
    or.push({ [fields.owner]: access.ownerId });
  }
  return or.length ? { OR: or } : null;
}

/** Vérifie qu'une cible précise (société, département, propriétaire) est couverte par l'accès. */
export function covers(
  access: Access,
  target: { companyId?: string | null; departmentId?: string | null; ownerId?: string | null },
): boolean {
  if (access.kind === 'all') return true;
  if (access.kind === 'none') return false;
  if (target.companyId && access.companyIds.includes(target.companyId)) return true;
  if (target.departmentId && access.departmentIds.includes(target.departmentId)) return true;
  if (target.ownerId && access.ownerId === target.ownerId) return true;
  return false;
}
