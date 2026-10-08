import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsIn, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { forbidden, notFound } from '../common/errors';
import { Access, Principal } from '../permissions/access';
import { ACTIONS, MODULE_LABELS, MODULES, SCOPES } from '../permissions/catalog';
import { CurrentAccess, CurrentUser, RequirePermission } from '../permissions/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';

class PermissionDto {
  @IsIn(MODULES) module: string;
  @IsIn(ACTIONS) action: string;
  @IsIn(SCOPES) scope: (typeof SCOPES)[number];
}

class CreateRoleDto {
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() description?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => PermissionDto) permissions: PermissionDto[];
}

class UpdateRoleDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PermissionDto) permissions?: PermissionDto[];
}

function assertNoDuplicates(permissions: PermissionDto[]) {
  const keys = permissions.map((p) => `${p.module}:${p.action}`);
  if (new Set(keys).size !== keys.length) throw new BadRequestException('Une même action est définie deux fois');
}

/** Seul un accès groupe peut définir des permissions de portée « toutes sociétés ». */
function assertCanGrant(access: Access, permissions: PermissionDto[]) {
  if (access.kind !== 'all' && permissions.some((p) => p.scope === 'ALL')) {
    throw forbidden('La portée « toutes sociétés » est réservée au niveau groupe');
  }
}

@Controller('roles')
export class RolesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Catalogue des modules, actions et portées, pour construire l'écran des profils. */
  @Get('catalog')
  catalog() {
    return {
      modules: MODULES.map((key) => ({ key, label: MODULE_LABELS[key] })),
      actions: ACTIONS,
      scopes: SCOPES,
    };
  }

  @Get()
  @RequirePermission('roles', 'read')
  list() {
    return this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { permissions: true, _count: { select: { users: true } } },
    });
  }

  @Post()
  @RequirePermission('roles', 'create')
  async create(@Body() dto: CreateRoleDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    assertNoDuplicates(dto.permissions);
    assertCanGrant(access, dto.permissions);
    if (await this.prisma.role.findUnique({ where: { name: dto.name } })) throw new ConflictException('Ce nom de rôle existe déjà');

    const role = await this.prisma.role.create({
      data: { name: dto.name, description: dto.description, permissions: { create: dto.permissions } },
      include: { permissions: true },
    });
    await this.audit.log({ actorId: principal.id, action: 'create', entity: 'Role', entityId: role.id, after: role });
    return role;
  }

  @Patch(':id')
  @RequirePermission('roles', 'update')
  async update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const before = await this.prisma.role.findUnique({ where: { id }, include: { permissions: true } });
    if (!before) throw notFound('Rôle');
    // Modifier un rôle change les droits de tous ses titulaires, dans toutes les sociétés.
    if (access.kind !== 'all' && (before.isSystem || before.permissions.some((p) => p.scope === 'ALL'))) {
      throw forbidden('Ce rôle ne peut être modifié qu’au niveau groupe');
    }
    if (before.isSystem && dto.name && dto.name !== before.name) throw new BadRequestException('Un rôle système ne peut pas être renommé');
    if (dto.permissions) {
      assertNoDuplicates(dto.permissions);
      assertCanGrant(access, dto.permissions);
    }

    const after = await this.prisma.$transaction(async (tx) => {
      if (dto.permissions) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: dto.permissions.map((p) => ({ ...p, roleId: id })) });
      }
      return tx.role.update({
        where: { id },
        data: { name: dto.name, description: dto.description },
        include: { permissions: true },
      });
    });
    await this.audit.log({ actorId: principal.id, action: 'update', entity: 'Role', entityId: id, before, after });
    return after;
  }

  @Delete(':id')
  @RequirePermission('roles', 'delete')
  async remove(@Param('id') id: string, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const before = await this.prisma.role.findUnique({ where: { id }, include: { permissions: true, _count: { select: { users: true } } } });
    if (!before) throw notFound('Rôle');
    if (before.isSystem) throw new BadRequestException('Un rôle système ne peut pas être supprimé');
    if (access.kind !== 'all' && before.permissions.some((p) => p.scope === 'ALL')) throw forbidden();
    if (before._count.users > 0) throw new ConflictException('Retirez ce rôle à ses titulaires avant de le supprimer');

    await this.prisma.role.delete({ where: { id } });
    await this.audit.log({ actorId: principal.id, action: 'delete', entity: 'Role', entityId: id, before });
    return { deleted: true };
  }
}

@Module({ controllers: [RolesController] })
export class RolesModule {}
