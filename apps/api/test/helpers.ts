import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';

/**
 * Prépare un schéma PostgreSQL vide dédié à un fichier de tests.
 * À appeler avant d'importer AppModule, pour que Prisma lise la bonne URL.
 */
export function useTestSchema(schema: string) {
  const base = process.env.DATABASE_URL ?? 'postgresql://gestion:gestion@localhost:5432/gestion';
  process.env.DATABASE_URL = `${base.split('?')[0]}?schema=${schema}`;
  process.env.JWT_SECRET = 'test-secret';
  process.env.ALLOW_DEV_LOGIN = 'true';
  return schema;
}

export async function resetSchema(schema: string) {
  const prisma = new PrismaClient();
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  execSync('npx prisma migrate deploy', { env: process.env, stdio: 'ignore' });
  return prisma;
}

export async function startApp(override?: (builder: ReturnType<typeof Test.createTestingModule>) => void) {
  const { AppModule } = await import('../src/app.module');
  const { configureApp } = await import('../src/bootstrap');
  const builder = Test.createTestingModule({ imports: [AppModule] });
  override?.(builder);
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  return app;
}

/** Petit client HTTP : une session par personne. */
export function sessions(app: INestApplication) {
  const tokens: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  return {
    async login(who: string, email: string) {
      const res = await http().post('/auth/dev-login').send({ email }).expect(201);
      tokens[who] = res.body.accessToken;
    },
    as(who: string) {
      const auth = { Authorization: `Bearer ${tokens[who]}` };
      return {
        get: (url: string) => http().get(url).set(auth),
        post: (url: string, body: object = {}) => http().post(url).set(auth).send(body),
        patch: (url: string, body: object) => http().patch(url).set(auth).send(body),
        delete: (url: string) => http().delete(url).set(auth),
      };
    },
    http,
  };
}
