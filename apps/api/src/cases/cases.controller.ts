import { BadRequestException, Body, Controller, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { forbidden, notFound } from '../common/errors';
import { CASE_SCOPE } from '../emails/emails.controller';
import { Access, canCreateIn, covers, Principal, scopeWhere } from '../permissions/access';
import { CurrentAccess, CurrentUser, RequirePermission } from '../permissions/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';

class CreateCaseDto {
  @IsString() @MinLength(2) title: string;
  /** Société du dossier ; par défaut celle de l'utilisateur. */
  @IsOptional() @IsString() companyId?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsString() clientAccountId?: string;
}

class UpdateCaseDto {
  @IsOptional() @IsString() @MinLength(2) title?: string;
  @IsOptional() @IsIn(['OPEN', 'ON_HOLD', 'CLOSED']) status?: 'OPEN' | 'ON_HOLD' | 'CLOSED';
}

@Controller('cases')
export class CasesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('cases', 'read')
  list(@CurrentAccess() access: Access, @Query('status') status?: string, @Query('companyId') companyId?: string) {
    const scope = scopeWhere(access, CASE_SCOPE);
    if (!scope) return [];
    return this.prisma.case.findMany({
      where: { AND: [scope, status ? { status: status as 'OPEN' } : {}, companyId ? { companyId } : {}] },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: {
        clientAccount: { select: { id: true, name: true } },
        owner: { select: { id: true, fullName: true } },
        _count: { select: { threads: true } },
      },
    });
  }

  @Post()
  @RequirePermission('cases', 'create')
  async create(@Body() dto: CreateCaseDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const companyId = dto.companyId ?? principal.companyId;
    if (!companyId) throw new BadRequestException('Société requise');
    const departmentId = dto.departmentId ?? (companyId === principal.companyId ? principal.departmentId : null);
    if (departmentId) {
      const department = await this.prisma.department.findUnique({ where: { id: departmentId } });
      if (department?.companyId !== companyId) throw new BadRequestException('Le département doit appartenir à la société');
    }
    if (dto.clientAccountId) {
      const account = await this.prisma.clientAccount.findUnique({ where: { id: dto.clientAccountId } });
      if (account?.companyId !== companyId) throw new BadRequestException('Client introuvable dans cette société');
    }
    if (!canCreateIn(access, principal, { companyId, departmentId })) throw forbidden();

    const created = await this.createWithReference({
      title: dto.title,
      companyId,
      departmentId,
      clientAccountId: dto.clientAccountId,
      ownerId: principal.id,
    });
    await this.audit.log({ actorId: principal.id, action: 'create', entity: 'Case', entityId: created.id, after: created });
    return created;
  }

  @Patch(':id')
  @RequirePermission('cases', 'update')
  async update(@Param('id') id: string, @Body() dto: UpdateCaseDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const before = await this.prisma.case.findUnique({ where: { id } });
    if (!before) throw notFound('Dossier');
    if (!covers(access, { companyId: before.companyId, departmentId: before.departmentId, ownerId: before.ownerId })) throw forbidden();
    const after = await this.prisma.case.update({ where: { id }, data: dto });
    await this.audit.log({ actorId: principal.id, action: 'update', entity: 'Case', entityId: id, before, after });
    return after;
  }

  /** Référence D-AAAA-NNNN, unique et croissante sur l'année. */
  private async createWithReference(data: {
    title: string;
    companyId: string;
    departmentId: string | null;
    clientAccountId?: string;
    ownerId: string;
  }) {
    const year = new Date().getFullYear();
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.prisma.case.findFirst({
        where: { reference: { startsWith: `D-${year}-` } },
        orderBy: { reference: 'desc' },
      });
      const next = last ? Number(last.reference.split('-')[2]) + 1 : 1;
      try {
        return await this.prisma.case.create({ data: { ...data, reference: `D-${year}-${String(next).padStart(4, '0')}` } });
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e; // référence prise entre-temps : on réessaie
      }
    }
    throw new BadRequestException('Impossible d’attribuer une référence, réessayez');
  }
}

@Module({ controllers: [CasesController] })
export class CasesModule {}
