import { Controller, Get, Module, Query } from '@nestjs/common';
import { Access, scopeWhere } from '../permissions/access';
import { CurrentAccess, RequirePermission } from '../permissions/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('audit')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  /** Journal d'audit, filtré sur les actions des utilisateurs de sa portée. */
  @Get()
  @RequirePermission('audit', 'read')
  list(@CurrentAccess() access: Access, @Query('entity') entity?: string, @Query('entityId') entityId?: string) {
    const actor = scopeWhere(access, { company: 'companyId', department: 'departmentId', owner: 'id' });
    return this.prisma.auditLog.findMany({
      where: {
        ...(actor === null ? { id: '__none__' } : Object.keys(actor).length ? { actor: actor } : {}),
        ...(entity ? { entity } : {}),
        ...(entityId ? { entityId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { actor: { select: { id: true, fullName: true, email: true } } },
    });
  }
}

@Module({ controllers: [AuditController] })
export class AuditViewModule {}
