import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { seedRoles } from '../prisma/seed';
import { GMAIL_API } from '../src/emails/gmail.client';
import { FakeGmail } from './fake-gmail';
import { resetSchema, sessions, startApp, useTestSchema } from './helpers';

const SCHEMA = useTestSchema('e2e_emails');
process.env.GMAIL_PUSH_TOKEN = 'secret-push';

jest.setTimeout(60_000);

type Thread = { id: string; subject: string; caseId: string | null; linkedBy: string | null; contact: { email: string } | null; _count: { messages: number } };

describe('E-mails centralisés (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let s: ReturnType<typeof sessions>;
  const gmail = new FakeGmail();
  const ids: Record<string, string> = {};

  const pushFor = (email: string) =>
    s.http()
      .post('/emails/push?token=secret-push')
      .send({ message: { data: Buffer.from(JSON.stringify({ emailAddress: email, historyId: 1 })).toString('base64') } });

  const threadsOf = async (who: string, query = '') => (await s.as(who).get(`/emails/threads${query}`).expect(200)).body as Thread[];

  beforeAll(async () => {
    prisma = await resetSchema(SCHEMA);
    await seedRoles(prisma);
    await prisma.user.create({ data: { email: 'root@groupe.ci', fullName: 'Root', isSuperAdmin: true } });
    app = await startApp((builder) => builder.overrideProvider(GMAIL_API).useValue(gmail));
    s = sessions(app);
    await s.login('root', 'root@groupe.ci');

    ids.alpha = (await s.as('root').post('/companies', { name: 'Alpha SARL' }).expect(201)).body.id;
    ids.commercial = (await s.as('root').post('/departments', { companyId: ids.alpha, name: 'Commercial' }).expect(201)).body.id;
    ids.finance = (await s.as('root').post('/departments', { companyId: ids.alpha, name: 'Finance' }).expect(201)).body.id;

    const people = [
      ['vendeur', 'vendeur@alpha.ci', ids.commercial, 'Collaborateur'],
      ['chef', 'chef@alpha.ci', ids.commercial, 'Responsable de département'],
      ['compta', 'compta@alpha.ci', ids.finance, 'Collaborateur'],
      ['dg', 'dg@alpha.ci', null, 'Directeur Général'],
    ] as const;
    for (const [who, email, departmentId, role] of people) {
      const user = await s.as('root').post('/users', { email, fullName: who, companyId: ids.alpha, ...(departmentId ? { departmentId } : {}) }).expect(201);
      const roleId = (await prisma.role.findUniqueOrThrow({ where: { name: role } })).id;
      await s.as('root').post(`/users/${user.body.id}/roles`, { roleId }).expect(201);
      await s.login(who, email);
    }

    ids.client = (await s.as('root').post('/crm/clients', { name: 'Client SA', domain: 'client.ci', companyId: ids.alpha }).expect(201)).body.id;
    const kase = await s.as('root').post('/cases', { title: 'Équipement du siège', companyId: ids.alpha, departmentId: ids.commercial, clientAccountId: ids.client }).expect(201);
    ids.case = kase.body.id;
    ids.caseRef = kase.body.reference;
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('numérote les dossiers et limite leur création au périmètre', async () => {
    expect(ids.caseRef).toMatch(/^D-\d{4}-0001$/);
    const own = await s.as('vendeur').post('/cases', { title: 'Relance prospect' }).expect(201);
    expect(own.body.reference).toMatch(/^D-\d{4}-0002$/);
    expect(own.body.departmentId).toBe(ids.commercial);
    await s.as('vendeur').post('/cases', { title: 'Hors périmètre', departmentId: ids.finance }).expect(403);
    await s.as('root').post('/crm/clients', { name: 'Perso', domain: 'gmail.com', companyId: ids.alpha }).expect(400);
  });

  it('crée une boîte pour chaque utilisateur et importe les messages', async () => {
    const provision = await s.as('root').post('/emails/mailboxes/provision').expect(201);
    expect(provision.body.created).toBe(4);
    await s.as('vendeur').post('/emails/mailboxes/provision').expect(403);

    gmail.deliver('vendeur@alpha.ci', { threadId: 'ta', from: 'Awa Traoré <awa@client.ci>', to: 'vendeur@alpha.ci', subject: 'Demande de devis', body: 'Bonjour, pouvez-vous nous chiffrer…' });
    gmail.deliver('vendeur@alpha.ci', { threadId: 'tb', from: 'inconnu@autre.ci', to: 'vendeur@alpha.ci', subject: 'Partenariat', body: 'Proposition de partenariat' });
    gmail.deliver('compta@alpha.ci', { threadId: 'tc', from: 'fournisseur@gmail.com', to: 'compta@alpha.ci', subject: `Facture ${ids.caseRef.toLowerCase()}`, body: 'Ci-joint la facture' });
    gmail.deliver('compta@alpha.ci', { threadId: 'td', from: 'compta@alpha.ci', to: 'collegue@alpha.ci', subject: 'Note interne', body: 'Interne', sent: true });

    const sync = await s.as('root').post('/emails/sync').expect(201);
    const imported = Object.fromEntries(sync.body.map((r: { mailbox: string; imported: number }) => [r.mailbox, r.imported]));
    expect(imported).toMatchObject({ 'vendeur@alpha.ci': 2, 'compta@alpha.ci': 2, 'chef@alpha.ci': 0 });
  });

  it('rattache automatiquement par contact et par référence de dossier', async () => {
    const all = await threadsOf('dg');
    const bySubject = Object.fromEntries(all.map((t) => [t.subject, t]));

    expect(bySubject['Demande de devis']).toMatchObject({ caseId: ids.case, linkedBy: 'contact', contact: { email: 'awa@client.ci' } });
    expect(bySubject[`Facture ${ids.caseRef.toLowerCase()}`]).toMatchObject({ caseId: ids.case, linkedBy: 'reference' });
    expect(bySubject['Partenariat']).toMatchObject({ caseId: null, contact: null });
    expect(bySubject['Note interne']).toMatchObject({ caseId: null, contact: null });

    const contact = await prisma.contact.findFirstOrThrow({ where: { email: 'awa@client.ci' } });
    expect(contact.clientAccountId).toBe(ids.client);
  });

  it('applique les permissions à la boîte de réception unifiée', async () => {
    expect((await threadsOf('dg')).length).toBe(4);
    expect((await threadsOf('vendeur')).map((t) => t.subject).sort()).toEqual(['Demande de devis', 'Partenariat']);
    expect((await threadsOf('compta')).length).toBe(2);
    expect((await threadsOf('chef')).map((t) => t.subject).sort()).toEqual(['Demande de devis', 'Partenariat']);

    const foreign = (await threadsOf('dg')).find((t) => t.subject === 'Note interne')!;
    await s.as('vendeur').get(`/emails/threads/${foreign.id}`).expect(404);
    const detail = await s.as('compta').get(`/emails/threads/${foreign.id}`).expect(200);
    expect(detail.body.messages[0]).toMatchObject({ direction: 'OUTBOUND', bodyText: 'Interne' });
  });

  it('permet de classer un fil à la main, dans les dossiers accessibles', async () => {
    const pending = await threadsOf('vendeur', '?filter=unclassified');
    expect(pending.map((t) => t.subject)).toEqual(['Partenariat']);
    const id = pending[0].id;

    // Le dossier appartient au département, pas au vendeur : il ne le voit pas.
    await s.as('vendeur').patch(`/emails/threads/${id}`, { caseId: ids.case }).expect(403);
    const done = await s.as('chef').patch(`/emails/threads/${id}`, { caseId: ids.case }).expect(200);
    expect(done.body).toMatchObject({ caseId: ids.case, linkedBy: 'manual' });
    await s.as('compta').patch(`/emails/threads/${id}`, { caseId: null }).expect(403);

    expect(await threadsOf('dg', `?caseId=${ids.case}`)).toHaveLength(3);
    expect(await threadsOf('dg', '?q=partenariat')).toHaveLength(1);
  });

  it('importe les nouveaux messages sur notification push, sans doublon', async () => {
    await s.http().post('/emails/push?token=mauvais').send({}).expect(403);

    gmail.deliver('vendeur@alpha.ci', { threadId: 'ta', from: 'vendeur@alpha.ci', to: 'awa@client.ci', subject: 'Re: Demande de devis', body: 'Voici notre devis', sent: true });
    await pushFor('vendeur@alpha.ci').expect(204);
    await pushFor('vendeur@alpha.ci').expect(204);

    const thread = (await threadsOf('vendeur')).find((t) => t.subject === 'Demande de devis')!;
    expect(thread._count.messages).toBe(2);
    expect(await prisma.emailMessage.count()).toBe(5);
  });

  it('se resynchronise quand l’historique Gmail a expiré', async () => {
    gmail.deliver('compta@alpha.ci', { threadId: 'te', from: 'banque@banque.ci', to: 'compta@alpha.ci', subject: 'Relevé', body: 'Votre relevé' });
    gmail.expireHistory('compta@alpha.ci');
    await pushFor('compta@alpha.ci').expect(204);

    expect(await prisma.emailMessage.count()).toBe(6);
    const mailbox = await prisma.mailbox.findUniqueOrThrow({ where: { email: 'compta@alpha.ci' } });
    expect(mailbox.syncError).toBeNull();
  });
});
