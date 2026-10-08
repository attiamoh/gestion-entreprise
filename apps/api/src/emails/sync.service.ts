import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Mailbox } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GMAIL_API, GmailApi, HistoryExpiredError } from './gmail.client';
import { LinkerService } from './linker.service';
import { parseGmailMessage } from './mime';

export interface SyncResult {
  mailbox: string;
  imported: number;
  error?: string;
}

/** Synchronise les boîtes Gmail nominatives vers la base centrale. */
@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);
  private readonly running = new Map<string, Promise<SyncResult>>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly linker: LinkerService,
    @Inject(GMAIL_API) private readonly gmail: GmailApi,
  ) {}

  /** Relève périodique, en complément des notifications push de Gmail. */
  onModuleInit() {
    const minutes = Number(process.env.EMAIL_SYNC_INTERVAL_MINUTES);
    if (minutes > 0) this.timer = setInterval(() => void this.syncAll(), minutes * 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Crée une boîte pour chaque utilisateur actif rattaché à une société : toutes les boîtes nominatives sont captées. */
  async provisionMailboxes() {
    const users = await this.prisma.user.findMany({ where: { isActive: true, companyId: { not: null }, mailbox: null } });
    for (const user of users) await this.prisma.mailbox.create({ data: { userId: user.id, email: user.email } });
    return { created: users.length };
  }

  /** Abonne chaque boîte aux notifications push (à renouveler au moins tous les 7 jours). */
  async watchAll(topicName: string) {
    const mailboxes = await this.prisma.mailbox.findMany();
    let watched = 0;
    for (const mailbox of mailboxes) {
      try {
        const { expiration } = await this.gmail.watch(mailbox.email, topicName);
        await this.prisma.mailbox.update({ where: { id: mailbox.id }, data: { watchExpires: expiration } });
        watched++;
      } catch (e) {
        await this.prisma.mailbox.update({ where: { id: mailbox.id }, data: { syncError: (e as Error).message } });
      }
    }
    return { watched, total: mailboxes.length };
  }

  async syncAll(): Promise<SyncResult[]> {
    const mailboxes = await this.prisma.mailbox.findMany({ include: { user: true } });
    const results: SyncResult[] = [];
    for (const mailbox of mailboxes) {
      if (!mailbox.user.isActive) continue;
      results.push(await this.syncMailbox(mailbox.email));
    }
    return results;
  }

  /** Une seule synchronisation à la fois par boîte ; les appels concurrents attendent la même. */
  syncMailbox(email: string): Promise<SyncResult> {
    const key = email.toLowerCase();
    const pending = this.running.get(key);
    if (pending) return pending;
    const run = this.doSync(key).finally(() => this.running.delete(key));
    this.running.set(key, run);
    return run;
  }

  private async doSync(email: string): Promise<SyncResult> {
    const mailbox = await this.prisma.mailbox.findUnique({ where: { email } });
    if (!mailbox) return { mailbox: email, imported: 0, error: 'Boîte inconnue' };

    try {
      const imported = mailbox.historyId ? await this.incremental(mailbox) : await this.initial(mailbox);
      await this.prisma.mailbox.update({ where: { id: mailbox.id }, data: { lastSyncedAt: new Date(), syncError: null } });
      return { mailbox: email, imported };
    } catch (e) {
      const message = (e as Error).message;
      this.logger.warn(`Synchronisation de ${email} en échec : ${message}`);
      await this.prisma.mailbox.update({ where: { id: mailbox.id }, data: { syncError: message } });
      return { mailbox: email, imported: 0, error: message };
    }
  }

  /** Première synchronisation : les messages des derniers jours (30 par défaut). */
  private async initial(mailbox: Mailbox) {
    const { historyId } = await this.gmail.getProfile(mailbox.email);
    const days = Number(process.env.EMAIL_INITIAL_SYNC_DAYS ?? 30);
    let imported = 0;
    let pageToken: string | undefined;
    do {
      const page = await this.gmail.listMessageIds(mailbox.email, `newer_than:${days}d -in:chats -in:spam -in:trash`, pageToken);
      for (const id of page.ids) imported += await this.importMessage(mailbox, id);
      pageToken = page.nextPageToken;
    } while (pageToken);
    await this.prisma.mailbox.update({ where: { id: mailbox.id }, data: { historyId } });
    return imported;
  }

  /** Synchronisation incrémentale depuis le dernier historyId traité. */
  private async incremental(mailbox: Mailbox) {
    let imported = 0;
    let pageToken: string | undefined;
    let historyId = mailbox.historyId!;
    try {
      do {
        const page = await this.gmail.listHistory(mailbox.email, mailbox.historyId!, pageToken);
        for (const id of page.messageIds) imported += await this.importMessage(mailbox, id);
        historyId = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (e) {
      if (!(e instanceof HistoryExpiredError)) throw e;
      // Historique trop ancien (boîte restée longtemps sans synchronisation) : on repart de zéro.
      await this.prisma.mailbox.update({ where: { id: mailbox.id }, data: { historyId: null } });
      return this.initial({ ...mailbox, historyId: null });
    }
    await this.prisma.mailbox.update({ where: { id: mailbox.id }, data: { historyId } });
    return imported;
  }

  /** Enregistre un message (sans doublon) et met à jour le rattachement de son fil. Renvoie 1 si importé. */
  private async importMessage(mailbox: Mailbox, gmailMessageId: string): Promise<number> {
    const exists = await this.prisma.emailMessage.findUnique({
      where: { mailboxId_gmailMessageId: { mailboxId: mailbox.id, gmailMessageId } },
    });
    if (exists) return 0;

    const raw = await this.gmail.getMessage(mailbox.email, gmailMessageId);
    if (!raw) return 0;
    if (raw.labelIds?.some((l) => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT')) return 0;

    const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: mailbox.userId } });
    if (!owner.companyId) return 0;

    const parsed = parseGmailMessage(raw);
    const outbound = parsed.labels.includes('SENT') || parsed.from.email === mailbox.email;

    const thread = await this.prisma.emailThread.upsert({
      where: { mailboxId_gmailThreadId: { mailboxId: mailbox.id, gmailThreadId: parsed.gmailThreadId } },
      create: {
        mailboxId: mailbox.id,
        gmailThreadId: parsed.gmailThreadId,
        companyId: owner.companyId,
        departmentId: owner.departmentId,
        ownerId: owner.id,
        subject: parsed.subject,
        lastMessageAt: parsed.sentAt,
      },
      update: {},
    });
    if (parsed.sentAt > thread.lastMessageAt) {
      await this.prisma.emailThread.update({ where: { id: thread.id }, data: { lastMessageAt: parsed.sentAt } });
    }

    await this.prisma.emailMessage.create({
      data: {
        threadId: thread.id,
        mailboxId: mailbox.id,
        gmailMessageId: parsed.gmailMessageId,
        rfcMessageId: parsed.rfcMessageId,
        direction: outbound ? 'OUTBOUND' : 'INBOUND',
        fromEmail: parsed.from.email,
        fromName: parsed.from.name,
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject,
        snippet: parsed.snippet,
        bodyText: parsed.bodyText,
        bodyHtml: parsed.bodyHtml,
        labels: parsed.labels,
        sentAt: parsed.sentAt,
        attachments: { create: parsed.attachments },
      },
    });
    await this.linker.link(thread.id);
    return 1;
  }
}
