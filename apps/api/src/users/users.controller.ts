import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { forbidden, notFound } from '../common/errors';
import { Access, covers, Principal, scopeWhere } from '../permissions/access';
import { CurrentAccess, CurrentUser, RequirePermission } from '../permissions/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';

class CreateUserDto {
  @IsEmail() email: string;
  @IsString() @MinLength(2) fullName: string;
  @IsString() companyId: string;
  @IsOptional() @IsString() departmentId?: string;
}

class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(2) fullName?: string;
  @IsOptional() @IsString() companyId?: string;
  @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() departmentId?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class AssignRoleDto {
  @IsString() roleId: string;
  /** Limite le rôle à une société ; vide = société de l'utilisateur. */
  @IsOptional() @IsString() companyId?: string;
}

const PUBLIC_FIELDS = {
  id: true,
  email: true,
  fullName: true,
  isActive: true,
  isSuperAdmin: true,
  companyId: true,
  departmentId: true,
  company: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  roles: { select: { id: true, companyId: true, role: { select: { id: true, name: true } } } },
} as const;

@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('users', 'read')
  list(@Query('companyId') companyId: string | undefined, @CurrentAccess() access: Access) {
    const scope = scopeWhere(access, { company: 'companyId', department: 'departmentId', owner: 'id' }) ?? { id: '__none__' };
    return this.prisma.user.findMany({
      where: { AND: [scope, companyId ? { companyId } : {}] },
      orderBy: { fullName: 'asc' },
      select: PUBLIC_FIELDS,
    });
  }

  @Post()
  @RequirePermission('users', 'create')
  async create(@Body() dto: CreateUserDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    await this.assertPlacement(dto.companyId, dto.departmentId);
    if (!covers(access, { companyId: dto.companyId, departmentId: dto.departmentId })) throw forbidden();
    const email = dto.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('Cet e-mail existe déjà');

    const user = await this.prisma.user.create({ data: { ...dto, email }, select: PUBLIC_FIELDS });
    await this.audit.log({ actorId: principal.id, action: 'create', entity: 'User', entityId: user.id, after: user });
    return user;
  }

  @Patch(':id')
  @RequirePermission('users', 'update')
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const before = await this.prisma.user.findUnique({ where: { id }, select: PUBLIC_FIELDS });
    if (!before) throw notFound('Utilisateur');
    if (!covers(access, { companyId: before.companyId, departmentId: before.departmentId, ownerId: id })) throw forbidden();
    if (before.isSuperAdmin && !principal.isSuperAdmin) throw forbidden('Seul un super admin peut modifier un super admin');
    if (dto.isActive === false && id === principal.id) throw new BadRequestException('Vous ne pouvez pas désactiver votre propre compte');

    const companyId = dto.companyId ?? before.companyId;
    const departmentId = dto.departmentId === undefined ? before.departmentId : dto.departmentId;
    if (dto.companyId !== undefined || dto.departmentId !== undefined) {
      if (!companyId) throw new BadRequestException('Société requise');
      await this.assertPlacement(companyId, departmentId ?? undefined);
      if (!covers(access, { companyId, departmentId })) throw forbidden();
    }

    const after = await this.prisma.user.update({
      where: { id },
      data: { ...dto, departmentId, companyId },
      select: PUBLIC_FIELDS,
    });
    await this.audit.log({ actorId: principal.id, action: 'update', entity: 'User', entityId: id, before, after });
    return after;
  }

  /**
   * Attribuer un rôle. Garde-fous contre l'élévation de privilèges :
   * un rôle qui donne une portée « toutes sociétés » ne peut être attribué
   * que par quelqu'un qui a lui-même cette portée sur les rôles.
   */
  @Post(':id/roles')
  @RequirePermission('roles', 'update')
  async assignRole(@Param('id') id: string, @Body() dto: AssignRoleDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw notFound('Utilisateur');
    const role = await this.prisma.role.findUnique({ where: { id: dto.roleId }, include: { permissions: true } });
    if (!role) throw notFound('Rôle');

    const targetCompany = dto.companyId ?? user.companyId;
    if (!covers(access, { companyId: targetCompany })) throw forbidden();
    if (role.permissions.some((p) => p.scope === 'ALL') && access.kind !== 'all') {
      throw forbidden('Ce rôle donne un accès à tout le groupe : attribution réservée au niveau groupe');
    }
    if (id === principal.id && !principal.isSuperAdmin) throw forbidden('Vous ne pouvez pas modifier vos propres rôles');

    const existing = await this.prisma.userRole.findFirst({ where: { userId: id, roleId: role.id, companyId: dto.companyId ?? null } });
    if (existing) throw new ConflictException('Ce rôle est déjà attribué');
    const grant = await this.prisma.userRole.create({ data: { userId: id, roleId: role.id, companyId: dto.companyId } });
    await this.audit.log({ actorId: principal.id, action: 'assign-role', entity: 'User', entityId: id, after: grant });
    return grant;
  }

  @Delete(':id/roles/:grantId')
  @RequirePermission('roles', 'update')
  async revokeRole(@Param('id') id: string, @Param('grantId') grantId: string, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const grant = await this.prisma.userRole.findUnique({ where: { id: grantId }, include: { user: true, role: { include: { permissions: true } } } });
    if (!grant || grant.userId !== id) throw notFound('Attribution');
    if (!covers(access, { companyId: grant.companyId ?? grant.user.companyId })) throw forbidden();
    if (grant.role.permissions.some((p) => p.scope === 'ALL') && access.kind !== 'all') throw forbidden();
    if (id === principal.id && !principal.isSuperAdmin) throw forbidden('Vous ne pouvez pas modifier vos propres rôles');

    await this.prisma.userRole.delete({ where: { id: grantId } });
    await this.audit.log({ actorId: principal.id, action: 'revoke-role', entity: 'User', entityId: id, before: grant });
    return { deleted: true };
  }

  private async assertPlacement(companyId: string, departmentId?: string | null) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw notFound('Société');
    if (departmentId) {
      const department = await this.prisma.department.findUnique({ where: { id: departmentId } });
      if (!department || department.companyId !== companyId) {
        throw new BadRequestException('Le département doit appartenir à la société choisie');
      }
    }
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
