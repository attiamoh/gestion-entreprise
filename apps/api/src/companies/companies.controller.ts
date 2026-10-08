import { Body, Controller, Delete, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, Length, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { forbidden, notFound } from '../common/errors';
import { Access, covers, Principal } from '../permissions/access';
import { CurrentAccess, CurrentUser, RequirePermission } from '../permissions/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';

class CreateCompanyDto {
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() legalForm?: string;
  @IsOptional() @IsString() rccm?: string;
  @IsOptional() @IsString() taxId?: string;
  @IsOptional() @IsString() @Length(2, 2) country?: string;
  @IsOptional() @IsString() @Length(3, 3) currency?: string;
}

class UpdateCompanyDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsString() legalForm?: string;
  @IsOptional() @IsString() rccm?: string;
  @IsOptional() @IsString() taxId?: string;
  @IsOptional() @IsString() @Length(2, 2) country?: string;
  @IsOptional() @IsString() @Length(3, 3) currency?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** Sociétés visibles : celles de la portée, plus toujours la sienne. */
function companyFilter(access: Access, principal: Principal) {
  if (access.kind === 'all') return {};
  const ids = access.kind === 'scoped' ? [...access.companyIds] : [];
  if (principal.companyId) ids.push(principal.companyId);
  return { id: { in: ids } };
}

@Controller('companies')
export class CompaniesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('companies', 'read')
  list(@CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    return this.prisma.company.findMany({
      where: companyFilter(access, principal),
      orderBy: { name: 'asc' },
      include: { _count: { select: { departments: true, users: true } } },
    });
  }

  @Get(':id')
  @RequirePermission('companies', 'read')
  async get(@Param('id') id: string, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const company = await this.prisma.company.findFirst({ where: { AND: [{ id }, companyFilter(access, principal)] } });
    if (!company) throw notFound('Société');
    return company;
  }

  /** Créer une société est réservé aux portées « toutes les sociétés ». */
  @Post()
  @RequirePermission('companies', 'create')
  async create(@Body() dto: CreateCompanyDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    if (access.kind !== 'all') throw forbidden('Seul un accès groupe peut créer une société');
    const company = await this.prisma.company.create({ data: dto });
    await this.audit.log({ actorId: principal.id, action: 'create', entity: 'Company', entityId: company.id, after: company });
    return company;
  }

  @Patch(':id')
  @RequirePermission('companies', 'update')
  async update(@Param('id') id: string, @Body() dto: UpdateCompanyDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const before = await this.prisma.company.findUnique({ where: { id } });
    if (!before) throw notFound('Société');
    if (!covers(access, { companyId: id })) throw forbidden();
    const after = await this.prisma.company.update({ where: { id }, data: dto });
    await this.audit.log({ actorId: principal.id, action: 'update', entity: 'Company', entityId: id, before, after });
    return after;
  }

  /** Une société n'est jamais supprimée physiquement : elle est désactivée. */
  @Delete(':id')
  @RequirePermission('companies', 'delete')
  async deactivate(@Param('id') id: string, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    if (access.kind !== 'all') throw forbidden('Seul un accès groupe peut désactiver une société');
    const before = await this.prisma.company.findUnique({ where: { id } });
    if (!before) throw notFound('Société');
    const after = await this.prisma.company.update({ where: { id }, data: { isActive: false } });
    await this.audit.log({ actorId: principal.id, action: 'deactivate', entity: 'Company', entityId: id, before, after });
    return after;
  }
}

@Module({ controllers: [CompaniesController] })
export class CompaniesModule {}
