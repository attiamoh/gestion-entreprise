import { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES } from '../src/permissions/system-roles';

const prisma = new PrismaClient();

/** Crée les rôles de départ et un super admin. Peut être relancé sans risque. */
export async function seedRoles(client: PrismaClient = prisma) {
  for (const role of SYSTEM_ROLES) {
    const existing = await client.role.findUnique({ where: { name: role.name } });
    if (existing) continue;
    await client.role.create({
      data: {
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        permissions: { create: role.permissions },
      },
    });
  }
}

async function main() {
  await seedRoles();

  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.ci').toLowerCase();
  await prisma.user.upsert({
    where: { email },
    update: { isSuperAdmin: true },
    create: { email, fullName: 'Super administrateur', isSuperAdmin: true },
  });

  if ((await prisma.company.count()) === 0) {
    const company = await prisma.company.create({ data: { name: 'Société démo', legalForm: 'SARL' } });
    for (const name of ['Direction générale', 'Commercial', 'Finance et comptabilité', 'Ressources humaines']) {
      await prisma.department.create({ data: { companyId: company.id, name } });
    }
  }
  console.log(`Rôles prêts. Super admin : ${email}`);
}

if (require.main === module) {
  main().finally(() => prisma.$disconnect());
}
