import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { forbidden, notFound } from '../common/errors';
import { Access, covers, Principal, scopeWhere } from '../permissions/access';
import { PermissionService } from '../permissions/permission.service';
import { CurrentAccess, CurrentUser, RequirePermission } from '../permissions/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';

class CreateDepartmentDto {
  @IsString() companyId: string;
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() parentId?: string;
  @IsOptional() @IsString() managerId?: string;
}

class UpdateDepartmentDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsString() code?: string;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() parentId?: string | null;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() managerId?: string | null;
}

/** Départements visibles : portée société, portée département, ou au moins le sien. */
function departmentFilter(access: Access, principal: Principal) {
  const where = scopeWhere(access, { company: 'companyId', department: 'id' });
  if (where && Object.keys(where).length === 0) return {};
  const or = (where?.OR as object[] | undefined) ?? [];
  if (principal.departmentId) or.push({ id: principal.departmentId });
  return { OR: or.length ? or : [{ id: '__none__' }] };
}

@Controller('departments')
export class DepartmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @RequirePermission('departments', 'read')
  list(@Query('companyId') companyId: string | undefined, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    return this.prisma.department.findMany({
      where: { AND: [departmentFilter(access, principal), companyId ? { companyId } : {}] },
      orderBy: [{ companyId: 'asc' }, { name: 'asc' }],
      include: {
        manager: { select: { id: true, fullName: true, email: true } },
        _count: { select: { members: true, children: true } },
      },
    });
  }

  @Post()
  @RequirePermission('departments', 'create')
  async create(@Body() dto: CreateDepartmentDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const company = await this.prisma.company.findUnique({ where: { id: dto.companyId } });
    if (!company) throw notFound('Société');
    if (dto.parentId) await this.assertParent(dto.parentId, dto.companyId);
    if (dto.managerId) await this.assertManager(dto.managerId, dto.companyId);
    // Un responsable de département peut créer des sous-départements sous le sien.
    if (!covers(access, { companyId: dto.companyId, departmentId: dto.parentId })) throw forbidden();
    await this.assertUniqueName(dto.companyId, dto.name);

    const department = await this.prisma.department.create({ data: dto });
    await this.audit.log({ actorId: principal.id, action: 'create', entity: 'Department', entityId: department.id, after: department });
    return department;
  }

  @Patch(':id')
  @RequirePermission('departments', 'update')
  async update(@Param('id') id: string, @Body() dto: UpdateDepartmentDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const before = await this.prisma.department.findUnique({ where: { id } });
    if (!before) throw notFound('Département');
    if (!covers(access, { companyId: before.companyId, departmentId: id })) throw forbidden();

    if (dto.parentId) {
      if (dto.parentId === id) throw new BadRequestException('Un département ne peut pas être son propre parent');
      await this.assertParent(dto.parentId, before.companyId);
      const subtree = await this.permissions.descendants(id);
      if (subtree.includes(dto.parentId)) throw new BadRequestException('Ce rattachement créerait une boucle');
      if (!covers(access, { companyId: before.companyId, departmentId: dto.parentId })) throw forbidden();
    }
    if (dto.managerId) await this.assertManager(dto.managerId, before.companyId);
    if (dto.name && dto.name !== before.name) await this.assertUniqueName(before.companyId, dto.name);

    const after = await this.prisma.department.update({ where: { id }, data: dto });
    await this.audit.log({ actorId: principal.id, action: 'update', entity: 'Department', entityId: id, before, after });
    return after;
  }

  @Delete(':id')
  @RequirePermission('departments', 'delete')
  async remove(@Param('id') id: string, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const before = await this.prisma.department.findUnique({
      where: { id },
      include: { _count: { select: { members: true, children: true } } },
    });
    if (!before) throw notFound('Département');
    if (!covers(access, { companyId: before.companyId, departmentId: id })) throw forbidden();
    if (before._count.members > 0 || before._count.children > 0) {
      throw new ConflictException('Réaffectez les membres et sous-départements avant de supprimer ce département');
    }
    await this.prisma.department.delete({ where: { id } });
    await this.audit.log({ actorId: principal.id, action: 'delete', entity: 'Department', entityId: id, before });
    return { deleted: true };
  }

  private async assertParent(parentId: string, companyId: string) {
    const parent = await this.prisma.department.findUnique({ where: { id: parentId } });
    if (!parent || parent.companyId !== companyId) {
      throw new BadRequestException('Le département parent doit appartenir à la même société');
    }
  }

  private async assertManager(managerId: string, companyId: string) {
    const manager = await this.prisma.user.findUnique({ where: { id: managerId } });
    if (!manager || manager.companyId !== companyId) {
      throw new BadRequestException('Le responsable doit appartenir à la même société');
    }
  }

  private async assertUniqueName(companyId: string, name: string) {
    const existing = await this.prisma.department.findFirst({ where: { companyId, name } });
    if (existing) throw new ConflictException('Un département porte déjà ce nom dans cette société');
  }
}

@Module({ controllers: [DepartmentsController] })
export class DepartmentsModule {}
