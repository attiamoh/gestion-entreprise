import { canCreateIn, covers, Principal, resolveAccess, scopeWhere, widestScope } from './access';

const base: Principal = {
  id: 'u1',
  email: 'a@b.ci',
  isSuperAdmin: false,
  companyId: 'c1',
  departmentId: 'd1',
  departmentIds: ['d1', 'd1a'],
  grants: [],
};

describe('resolveAccess', () => {
  it('donne tout au super admin', () => {
    expect(resolveAccess({ ...base, isSuperAdmin: true }, 'hr', 'read')).toEqual({ kind: 'all' });
  });

  it('refuse sans attribution', () => {
    expect(resolveAccess(base, 'hr', 'read')).toEqual({ kind: 'none' });
  });

  it('ALL l’emporte sur les autres portées (cas du DG)', () => {
    const p = {
      ...base,
      grants: [
        { module: 'crm', action: 'read', scope: 'OWN' as const, companyId: null },
        { module: 'crm', action: 'read', scope: 'ALL' as const, companyId: null },
      ],
    };
    expect(resolveAccess(p, 'crm', 'read')).toEqual({ kind: 'all' });
  });

  it('COMPANY utilise la société du rôle, sinon celle de l’utilisateur', () => {
    const p = {
      ...base,
      grants: [
        { module: 'crm', action: 'read', scope: 'COMPANY' as const, companyId: null },
        { module: 'crm', action: 'read', scope: 'COMPANY' as const, companyId: 'c2' },
      ],
    };
    const access = resolveAccess(p, 'crm', 'read');
    expect(access).toEqual({ kind: 'scoped', companyIds: ['c1', 'c2'], departmentIds: [], ownerId: null });
  });

  it('DEPARTMENT couvre les sous-départements et ses propres données', () => {
    const p = { ...base, grants: [{ module: 'tasks', action: 'read', scope: 'DEPARTMENT' as const, companyId: null }] };
    const access = resolveAccess(p, 'tasks', 'read');
    expect(access).toEqual({ kind: 'scoped', companyIds: [], departmentIds: ['d1', 'd1a'], ownerId: 'u1' });
    expect(covers(access, { departmentId: 'd1a' })).toBe(true);
    expect(covers(access, { departmentId: 'd2' })).toBe(false);
  });

  it('ne mélange pas les actions', () => {
    const p = { ...base, grants: [{ module: 'hr', action: 'read', scope: 'ALL' as const, companyId: null }] };
    expect(resolveAccess(p, 'hr', 'update')).toEqual({ kind: 'none' });
    expect(widestScope(p, 'hr', 'read')).toBe('ALL');
  });
});

describe('scopeWhere', () => {
  it('construit un OR sur les champs disponibles', () => {
    const where = scopeWhere(
      { kind: 'scoped', companyIds: ['c1'], departmentIds: ['d1'], ownerId: 'u1' },
      { company: 'companyId', department: 'departmentId', owner: 'id' },
    );
    expect(where).toEqual({
      OR: [{ companyId: { in: ['c1'] } }, { departmentId: { in: ['d1'] } }, { id: 'u1' }],
    });
  });

  it('renvoie null quand aucun champ ne correspond', () => {
    expect(scopeWhere({ kind: 'scoped', companyIds: [], departmentIds: [], ownerId: 'u1' }, { company: 'id' })).toBeNull();
    expect(scopeWhere({ kind: 'none' }, { company: 'id' })).toBeNull();
    expect(scopeWhere({ kind: 'all' }, { company: 'id' })).toEqual({});
  });
});

describe('canCreateIn', () => {
  const own = { kind: 'scoped' as const, companyIds: [], departmentIds: [], ownerId: 'u1' };
  it('limite une portée personnelle à sa société et son département', () => {
    expect(canCreateIn(own, base, { companyId: 'c1' })).toBe(true);
    expect(canCreateIn(own, base, { companyId: 'c1', departmentId: 'd1' })).toBe(true);
    expect(canCreateIn(own, base, { companyId: 'c1', departmentId: 'd2' })).toBe(false);
    expect(canCreateIn(own, base, { companyId: 'c2' })).toBe(false);
  });
  it('autorise les sous-départements avec la portée département', () => {
    const dept = { ...own, departmentIds: ['d1', 'd1a'] };
    expect(canCreateIn(dept, base, { companyId: 'c1', departmentId: 'd1a' })).toBe(true);
  });
  it('autorise toute la société avec la portée société', () => {
    expect(canCreateIn({ ...own, companyIds: ['c2'] }, base, { companyId: 'c2', departmentId: 'dx' })).toBe(true);
  });
});
