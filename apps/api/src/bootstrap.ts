import { INestApplication, ValidationPipe } from '@nestjs/common';

/** Configuration commune à l'application et aux tests. */
export function configureApp(app: INestApplication) {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' });
  return app;
}
