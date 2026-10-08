import { BadRequestException, Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ValidateIf, IsOptional, IsString } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { forbidden, notFound } from '../common/errors';
import { Access, covers, Principal, resolveAccess, scopeWhere } from '../permissions/access';
import { CurrentAccess, CurrentUser, Public, RequirePermission } from '../permissions/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { createGmailClient, GMAIL_API } from './gmail.client';
import { LinkerService } from './linker.service';
import { SyncService } from './sync.service';

class ClassifyThreadDto {
  /** Dossier auquel rattacher le fil ; null pour le remettre « à classer ». */
  @ValidateIf((_, v) => v !== null) @IsString() caseId: string | null;
}

class WatchDto {
  /** Sujet Pub/Sub, ex. projects/mon-projet/topics/gmail */
  @IsOptional() @IsString() topicName?: string;
}

export const THREAD_SCOPE = { company: 'companyId', department: 'departmentId', owner: 'ownerId' };
export const CASE_SCOPE = { company: 'companyId', department: 'departmentId', owner: 'ownerId' };

const requireSuperAdmin = (principal: Principal) => {
  if (!principal.isSuperAdmin) throw forbidden('Réservé au super admin');
};

@Controller('emails')
export class EmailsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: SyncService,
    private readonly audit: AuditService,
  ) {}

  /** Boîte de réception unifiée : fils visibles selon la portée, du plus récent au plus ancien. */
  @Get('threads')
  @RequirePermission('emails', 'read')
  async threads(
    @CurrentAccess() access: Access,
    @Query('filter') filter?: 'unclassified' | 'all',
    @Query('caseId') caseId?: string,
    @Query('q') q?: string,
  ) {
    const scope = scopeWhere(access, THREAD_SCOPE);
    if (!scope) return [];
    return this.prisma.emailThread.findMany({
      where: {
        AND: [
          scope,
          filter === 'unclassified' ? { caseId: null } : {},
          caseId ? { caseId } : {},
          q
            ? {
                OR: [
                  { subject: { contains: q, mode: 'insensitive' } },
                  { messages: { some: { fromEmail: { contains: q, mode: 'insensitive' } } } },
                  { messages: { some: { bodyText: { contains: q, mode: 'insensitive' } } } },
                ],
              }
            : {},
        ],
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
      include: {
        owner: { select: { id: true, fullName: true } },
        case: { select: { id: true, reference: true, title: true } },
        contact: { select: { id: true, email: true, fullName: true } },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: { fromEmail: true, fromName: true, snippet: true, sentAt: true, direction: true },
        },
        _count: { select: { messages: true } },
      },
    });
  }

  @Get('threads/:id')
  @RequirePermission('emails', 'read')
  async thread(@Param('id') id: string, @CurrentAccess() access: Access) {
    const scope = scopeWhere(access, THREAD_SCOPE);
    const thread = scope
      ? await this.prisma.emailThread.findFirst({
          where: { AND: [{ id }, scope] },
          include: {
            owner: { select: { id: true, fullName: true, email: true } },
            case: { select: { id: true, reference: true, title: true } },
            contact: { include: { clientAccount: { select: { id: true, name: true } } } },
            messages: { orderBy: { sentAt: 'asc' }, include: { attachments: true } },
          },
        })
      : null;
    if (!thread) throw notFound('Fil');
    return thread;
  }

  /** Classement manuel d'un fil dans un dossier ; il ne sera plus modifié automatiquement. */
  @Patch('threads/:id')
  @RequirePermission('emails', 'update')
  async classify(
    @Param('id') id: string,
    @Body() dto: ClassifyThreadDto,
    @CurrentAccess() access: Access,
    @CurrentUser() principal: Principal,
  ) {
    const before = await this.prisma.emailThread.findUnique({ where: { id } });
    if (!before) throw notFound('Fil');
    if (!covers(access, { companyId: before.companyId, departmentId: before.departmentId, ownerId: before.ownerId })) throw forbidden();

    if (dto.caseId) {
      const target = await this.prisma.case.findUnique({ where: { id: dto.caseId } });
      if (!target || target.companyId !== before.companyId) throw new BadRequestException('Dossier introuvable dans cette société');
      const caseAccess = resolveAccess(principal, 'cases', 'read');
      if (!covers(caseAccess, { companyId: target.companyId, departmentId: target.departmentId, ownerId: target.ownerId })) {
        throw forbidden('Ce dossier ne vous est pas accessible');
      }
    }

    const after = await this.prisma.emailThread.update({
      where: { id },
      data: { caseId: dto.caseId, linkedBy: dto.caseId ? 'manual' : null },
    });
    await this.audit.log({ actorId: principal.id, action: 'classify', entity: 'EmailThread', entityId: id, before, after });
    return after;
  }

  /**
   * Notification push de Gmail (via Pub/Sub). L'URL porte un jeton secret partagé
   * avec l'abonnement Pub/Sub : ?token=GMAIL_PUSH_TOKEN
   */
  @Public()
  @Post('push')
  @HttpCode(204)
  async push(@Query('token') token: string, @Body() body: { message?: { data?: string } }) {
    const expected = process.env.GMAIL_PUSH_TOKEN;
    if (!expected || token !== expected) throw forbidden('Jeton invalide');
    const data = body.message?.data;
    if (!data) return;
    let email: string | undefined;
    try {
      email = JSON.parse(Buffer.from(data, 'base64').toString('utf8')).emailAddress;
    } catch {
      return; // message illisible : on l'acquitte pour que Pub/Sub ne le renvoie pas en boucle
    }
    if (email) await this.sync.syncMailbox(email);
  }

  /** Crée les boîtes manquantes : une par utilisateur actif. */
  @Post('mailboxes/provision')
  provision(@CurrentUser() principal: Principal) {
    requireSuperAdmin(principal);
    return this.sync.provisionMailboxes();
  }

  @Get('mailboxes')
  async mailboxes(@CurrentUser() principal: Principal) {
    requireSuperAdmin(principal);
    return this.prisma.mailbox.findMany({
      orderBy: { email: 'asc' },
      select: { id: true, email: true, lastSyncedAt: true, syncError: true, watchExpires: true, _count: { select: { messages: true } } },
    });
  }

  @Post('mailboxes/watch')
  watch(@Body() dto: WatchDto, @CurrentUser() principal: Principal) {
    requireSuperAdmin(principal);
    const topic = dto.topicName ?? process.env.GMAIL_PUBSUB_TOPIC;
    if (!topic) throw new BadRequestException('Sujet Pub/Sub manquant (GMAIL_PUBSUB_TOPIC)');
    return this.sync.watchAll(topic);
  }

  /** Synchronisation immédiate de toutes les boîtes. */
  @Post('sync')
  syncNow(@CurrentUser() principal: Principal) {
    requireSuperAdmin(principal);
    return this.sync.syncAll();
  }
}

@Module({
  controllers: [EmailsController],
  providers: [SyncService, LinkerService, { provide: GMAIL_API, useFactory: createGmailClient }],
  exports: [SyncService],
})
export class EmailsModule {}
