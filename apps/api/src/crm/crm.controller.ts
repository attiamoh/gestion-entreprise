import { BadRequestException, Body, ConflictException, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { forbidden } from '../common/errors';
import { PUBLIC_DOMAINS } from '../emails/mime';
import { Access, canCreateIn, Principal } from '../permissions/access';
import { CurrentAccess, CurrentUser, RequirePermission } from '../permissions/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';

class CreateClientDto {
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() companyId?: string;
  @IsOptional() @Matches(/^[a-z0-9.-]+\.[a-z]{2,}$/i, { message: 'Domaine invalide (ex. client.ci)' }) domain?: string;
}

class CreateContactDto {
  @IsEmail() email: string;
  @IsOptional() @IsString() fullName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() clientAccountId?: string;
  @IsOptional() @IsString() companyId?: string;
}

/** Le carnet d'adresses est partagé dans une société : on filtre par société uniquement. */
function companyScope(access: Access, principal: Principal) {
  if (access.kind === 'all') return {};
  const ids = access.kind === 'scoped' ? [...access.companyIds] : [];
  if (principal.companyId) ids.push(principal.companyId);
  return { companyId: { in: ids } };
}

@Controller('crm')
export class CrmController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('clients')
  @RequirePermission('crm', 'read')
  clients(@CurrentAccess() access: Access, @CurrentUser() principal: Principal, @Query('companyId') companyId?: string) {
    return this.prisma.clientAccount.findMany({
      where: { AND: [companyScope(access, principal), companyId ? { companyId } : {}] },
      orderBy: { name: 'asc' },
      include: { _count: { select: { contacts: true, cases: true } } },
    });
  }

  @Post('clients')
  @RequirePermission('crm', 'create')
  async createClient(@Body() dto: CreateClientDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    const companyId = dto.companyId ?? principal.companyId;
    if (!companyId) throw new BadRequestException('Société requise');
    if (!canCreateIn(access, principal, { companyId })) throw forbidden();
    const domain = dto.domain?.toLowerCase();
    if (domain && PUBLIC_DOMAINS.has(domain)) throw new BadRequestException('Un domaine de messagerie grand public ne peut pas identifier un client');
    if (await this.prisma.clientAccount.findFirst({ where: { companyId, name: dto.name } })) throw new ConflictException('Ce client existe déjà');

    const client = await this.prisma.clientAccount.create({ data: { name: dto.name, domain, companyId, ownerId: principal.id } });
    await this.audit.log({ actorId: principal.id, action: 'create', entity: 'ClientAccount', entityId: client.id, after: client });
    return client;
  }

  @Get('contacts')
  @RequirePermission('crm', 'read')
  contacts(@CurrentAccess() access: Access, @CurrentUser() principal: Principal, @Query('clientAccountId') clientAccountId?: string) {
    return this.prisma.contact.findMany({
      where: { AND: [companyScope(access, principal), clientAccountId ? { clientAccountId } : {}] },
      orderBy: { email: 'asc' },
      include: { clientAccount: { select: { id: true, name: true } } },
    });
  }

  @Post('contacts')
  @RequirePermission('crm', 'create')
  async createContact(@Body() dto: CreateContactDto, @CurrentAccess() access: Access, @CurrentUser() principal: Principal) {
    let companyId = dto.companyId ?? principal.companyId;
    if (dto.clientAccountId) {
      const account = await this.prisma.clientAccount.findUnique({ where: { id: dto.clientAccountId } });
      if (!account) throw new BadRequestException('Client introuvable');
      companyId = account.companyId;
    }
    if (!companyId) throw new BadRequestException('Société requise');
    if (!canCreateIn(access, principal, { companyId })) throw forbidden();
    const email = dto.email.toLowerCase();
    if (await this.prisma.contact.findUnique({ where: { companyId_email: { companyId, email } } })) throw new ConflictException('Ce contact existe déjà');

    const contact = await this.prisma.contact.create({
      data: { email, fullName: dto.fullName, phone: dto.phone, clientAccountId: dto.clientAccountId, companyId },
    });
    await this.audit.log({ actorId: principal.id, action: 'create', entity: 'Contact', entityId: contact.id, after: contact });
    return contact;
  }
}

@Module({ controllers: [CrmController] })
export class CrmModule {}
