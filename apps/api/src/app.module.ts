import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuditViewModule } from './audit/audit.controller';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.controller';
import { CompaniesModule } from './companies/companies.controller';
import { DepartmentsModule } from './departments/departments.controller';
import { AuthGuard } from './permissions/auth.guard';
import { PermissionsModule } from './permissions/permissions.module';
import { PrismaModule } from './prisma/prisma.service';
import { RolesModule } from './roles/roles.controller';
import { UsersModule } from './users/users.controller';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '10h' },
    }),
    PrismaModule,
    AuditModule,
    PermissionsModule,
    AuthModule,
    CompaniesModule,
    DepartmentsModule,
    UsersModule,
    RolesModule,
    AuditViewModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
