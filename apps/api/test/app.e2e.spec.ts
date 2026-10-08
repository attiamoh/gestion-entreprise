import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { seedRoles } from '../prisma/seed';
import { resetSchema, startApp, useTestSchema } from './helpers';

const SCHEMA = useTestSchema('e2e');

jest.setTimeout(60_000);

describe('Sociétés, départements et permissions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const api = (who: string) => {
    const auth = { Authorization: `Bearer ${tokens[who]}` };
    const http = request(app.getHttpServer());
    return {
      get: (url: string) => http.get(url).set(auth),
      post: (url: string, body: object) => http.post(url).set(auth).send(body),
      patch: (url: string, body: object) => http.patch(url).set(auth).send(body),
      delete: (url: string) => http.delete(url).set(auth),
    };
  };

  const login = async (who: string, email: string) => {
    const res = await request(app.getHttpServer()).post('/auth/dev-login').send({ email }).expect(201);
    tokens[who] = res.body.accessToken;
  };

  const roleId = async (name: string) => (await prisma.role.findUniqueOrThrow({ where: { name } })).id;

  beforeAll(async () => {
    prisma = await resetSchema(SCHEMA);
    await seedRoles(prisma);
    await prisma.user.create({ data: { email: 'root@groupe.ci', fullName: 'Root', isSuperAdmin: true } });

    app = await startApp();
    await login('root', 'root@groupe.ci');
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('refuse les requêtes sans connexion', async () => {
    await request(app.getHttpServer()).get('/companies').expect(401);
  });

  it('le super admin met en place deux sociétés et leurs départements', async () => {
    ids.a = (await api('root').post('/companies', { name: 'Alpha SARL' }).expect(201)).body.id;
    ids.b = (await api('root').post('/companies', { name: 'Beta SA' }).expect(201)).body.id;
    const company = await api('root').get(`/companies/${ids.a}`).expect(200);
    expect(company.body).toMatchObject({ country: 'CI', currency: 'XOF' });

    ids.aCommercial = (await api('root').post('/departments', { companyId: ids.a, name: 'Commercial' }).expect(201)).body.id;
    ids.aVentes = (await api('root').post('/departments', { companyId: ids.a, name: 'Ventes Abidjan', parentId: ids.aCommercial }).expect(201)).body.id;
    ids.aFinance = (await api('root').post('/departments', { companyId: ids.a, name: 'Finance' }).expect(201)).body.id;
    ids.bRh = (await api('root').post('/departments', { companyId: ids.b, name: 'RH' }).expect(201)).body.id;

    await api('root').post('/departments', { companyId: ids.a, name: 'Commercial' }).expect(409);
    await api('root').post('/departments', { companyId: ids.b, name: 'X', parentId: ids.aCommercial }).expect(400);
    await api('root').patch(`/departments/${ids.aCommercial}`, { parentId: ids.aVentes }).expect(400);
  });

  it('crée des utilisateurs et leur attribue des rôles', async () => {
    const users = [
      ['dg', 'dg@groupe.ci', ids.a, undefined, 'Directeur Général'],
      ['adminA', 'admin@alpha.ci', ids.a, undefined, 'Administrateur'],
      ['chef', 'chef@alpha.ci', ids.a, ids.aCommercial, 'Responsable de département'],
      ['vendeur', 'vendeur@alpha.ci', ids.a, ids.aVentes, 'Collaborateur'],
      ['beta', 'agent@beta.ci', ids.b, ids.bRh, 'Collaborateur'],
    ] as const;
    for (const [who, email, companyId, departmentId, role] of users) {
      const user = await api('root').post('/users', { email, fullName: who, companyId, departmentId }).expect(201);
      ids[who] = user.body.id;
      await api('root').post(`/users/${user.body.id}/roles`, { roleId: await roleId(role) }).expect(201);
      await login(who, email);
    }
    await api('root').post('/users', { email: 'x@alpha.ci', fullName: 'X', companyId: ids.a, departmentId: ids.bRh }).expect(400);
  });

  it('le DG voit toutes les sociétés mais ne les administre pas', async () => {
    const companies = await api('dg').get('/companies').expect(200);
    expect(companies.body.map((c: { name: string }) => c.name).sort()).toEqual(['Alpha SARL', 'Beta SA']);
    expect((await api('dg').get('/departments').expect(200)).body).toHaveLength(4);
    await api('dg').post('/companies', { name: 'Gamma' }).expect(403);
    await api('dg').post('/departments', { companyId: ids.a, name: 'Achats' }).expect(403);
  });

  it("l'admin d'une société reste dans sa société", async () => {
    const departments = await api('adminA').get('/departments').expect(200);
    expect(departments.body.every((d: { companyId: string }) => d.companyId === ids.a)).toBe(true);
    expect(departments.body).toHaveLength(3);

    await api('adminA').post('/departments', { companyId: ids.a, name: 'Achats' }).expect(201);
    await api('adminA').post('/departments', { companyId: ids.b, name: 'Achats' }).expect(403);
    await api('adminA').patch(`/departments/${ids.bRh}`, { name: 'Pirate' }).expect(403);

    const users = await api('adminA').get('/users').expect(200);
    expect(users.body.some((u: { email: string }) => u.email === 'agent@beta.ci')).toBe(false);
  });

  it("l'admin ne peut pas s'élever ni élever quelqu'un au niveau groupe", async () => {
    await api('adminA').post(`/users/${ids.vendeur}/roles`, { roleId: await roleId('Directeur Général') }).expect(403);
    await api('adminA').post(`/users/${ids.adminA}/roles`, { roleId: await roleId('Comptable') }).expect(403);
    await api('adminA').post(`/users/${ids.beta}/roles`, { roleId: await roleId('Comptable') }).expect(403);
    await api('adminA').post(`/users/${ids.vendeur}/roles`, { roleId: await roleId('Comptable') }).expect(201);
  });

  it('les profils personnalisés respectent les mêmes garde-fous', async () => {
    const perms = [{ module: 'crm', action: 'read', scope: 'COMPANY' }];
    await api('root').post('/roles', { name: 'Assistant commercial', permissions: perms }).expect(201);
    await api('root').post('/roles', { name: 'Doublon', permissions: [...perms, ...perms] }).expect(400);
    await api('root').post('/roles', { name: 'Inconnu', permissions: [{ module: 'x', action: 'read', scope: 'OWN' }] }).expect(400);
    // L'admin a « roles: read, update » mais pas « create ».
    await api('adminA').post('/roles', { name: 'Admin maison', permissions: perms }).expect(403);
    const system = await roleId('Collaborateur');
    await api('adminA').patch(`/roles/${system}`, { permissions: [] }).expect(403);
    await api('root').delete(`/roles/${system}`).expect(400);
  });

  it('le responsable voit son département et ses sous-départements', async () => {
    const departments = await api('chef').get('/departments').expect(200);
    expect(departments.body.map((d: { name: string }) => d.name).sort()).toEqual(['Commercial', 'Ventes Abidjan']);
    await api('chef').post('/departments', { companyId: ids.a, name: 'Ventes Bouaké', parentId: ids.aCommercial }).expect(201);
    await api('chef').post('/departments', { companyId: ids.a, name: 'Hors périmètre' }).expect(403);
    await api('chef').patch(`/departments/${ids.aFinance}`, { name: 'Pirate' }).expect(403);

    const users = await api('chef').get('/users').expect(200);
    expect(users.body.map((u: { email: string }) => u.email).sort()).toEqual(['chef@alpha.ci', 'vendeur@alpha.ci']);
  });

  it('le collaborateur ne voit que son département et ne peut rien administrer', async () => {
    const departments = await api('beta').get('/departments').expect(200);
    expect(departments.body.map((d: { name: string }) => d.name)).toEqual(['RH']);
    const companies = await api('beta').get('/companies').expect(200);
    expect(companies.body.map((c: { name: string }) => c.name)).toEqual(['Beta SA']);
    await api('beta').get(`/companies/${ids.a}`).expect(404);
    await api('beta').post('/departments', { companyId: ids.b, name: 'Nouveau' }).expect(403);
    await api('beta').get('/roles').expect(403);
  });

  it('expose la matrice des droits et trace les actions', async () => {
    const me = await api('chef').get('/auth/me').expect(200);
    expect(me.body.permissions.departments).toMatchObject({ read: 'DEPARTMENT', delete: null });

    await api('root').delete(`/departments/${ids.aCommercial}`).expect(409);
    const logs = await api('root').get(`/audit?entity=Department&entityId=${ids.aCommercial}`).expect(200);
    expect(logs.body[0]).toMatchObject({ action: 'create', actor: { email: 'root@groupe.ci' } });
    const adminLogs = await api('adminA').get('/audit').expect(200);
    expect(adminLogs.body.every((l: { actor: { email: string } }) => l.actor.email.endsWith('@alpha.ci'))).toBe(true);
  });
});
