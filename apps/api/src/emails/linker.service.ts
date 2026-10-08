import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { domainOf, findCaseReferences, PUBLIC_DOMAINS } from './mime';

/**
 * Rattache un fil d'e-mails à un contact et à un dossier, dans cet ordre de priorité :
 * 1. une référence de dossier citée dans l'objet (ex. D-2026-0012) ;
 * 2. le contact externe reconnu (adresse connue, ou domaine d'une entreprise cliente),
 *    si son entreprise n'a qu'un seul dossier ouvert.
 * Un rattachement fait à la main n'est jamais remplacé.
 */
@Injectable()
export class LinkerService {
  constructor(private readonly prisma: PrismaService) {}

  async link(threadId: string) {
    const thread = await this.prisma.emailThread.findUniqueOrThrow({
      where: { id: threadId },
      include: {
        mailbox: true,
        messages: { orderBy: { sentAt: 'desc' }, select: { subject: true, direction: true, fromEmail: true, to: true, cc: true } },
      },
    });
    if (thread.linkedBy === 'manual') return thread;

    const update: { caseId?: string; contactId?: string; linkedBy?: string } = {};

    // 1. Référence de dossier dans l'objet
    if (!thread.caseId || thread.linkedBy === 'contact') {
      const references = findCaseReferences([thread.subject, ...thread.messages.map((m) => m.subject)].join(' '));
      if (references.length) {
        const found = await this.prisma.case.findFirst({
          where: { companyId: thread.companyId, reference: { in: references } },
          orderBy: { createdAt: 'desc' },
        });
        if (found) {
          update.caseId = found.id;
          update.linkedBy = 'reference';
        }
      }
    }

    // 2. Contact externe
    const contact = thread.contactId
      ? await this.prisma.contact.findUnique({ where: { id: thread.contactId } })
      : await this.findOrCreateContact(thread.companyId, thread.mailbox.email, thread.messages);
    if (contact && !thread.contactId) update.contactId = contact.id;

    if (!thread.caseId && !update.caseId && contact?.clientAccountId) {
      const open = await this.prisma.case.findMany({
        where: { companyId: thread.companyId, clientAccountId: contact.clientAccountId, status: 'OPEN' },
        take: 2,
      });
      if (open.length === 1) {
        update.caseId = open[0].id;
        update.linkedBy = 'contact';
      }
    }

    if (Object.keys(update).length === 0) return thread;
    return this.prisma.emailThread.update({ where: { id: threadId }, data: update });
  }

  /** Premier interlocuteur externe du fil : l'expéditeur des messages reçus, sinon le destinataire des messages envoyés. */
  private async findOrCreateContact(
    companyId: string,
    mailboxEmail: string,
    messages: { direction: string; fromEmail: string; to: string[]; cc: string[] }[],
  ) {
    const internalDomain = domainOf(mailboxEmail);
    const candidates = [
      ...messages.filter((m) => m.direction === 'INBOUND').map((m) => m.fromEmail),
      ...messages.filter((m) => m.direction === 'OUTBOUND').flatMap((m) => [...m.to, ...m.cc]),
    ];
    const external = [...new Set(candidates)].filter((email) => email.includes('@') && domainOf(email) !== internalDomain);
    if (!external.length) return null;

    const known = await this.prisma.contact.findFirst({ where: { companyId, email: { in: external } } });
    if (known) return known;

    for (const email of external) {
      const domain = domainOf(email);
      if (PUBLIC_DOMAINS.has(domain)) continue;
      const account = await this.prisma.clientAccount.findFirst({ where: { companyId, domain } });
      if (account) {
        return this.prisma.contact.upsert({
          where: { companyId_email: { companyId, email } },
          update: {},
          create: { companyId, email, clientAccountId: account.id },
        });
      }
    }
    return null;
  }
}
