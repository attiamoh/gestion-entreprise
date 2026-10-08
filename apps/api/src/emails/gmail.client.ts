import { gmail, gmail_v1 } from '@googleapis/gmail';
import { JWT } from 'google-auth-library';
import { readFileSync } from 'fs';

export type GmailMessage = gmail_v1.Schema$Message;

/** Le point de départ de l'historique est trop ancien : il faut resynchroniser. */
export class HistoryExpiredError extends Error {}

/** Accès Gmail pour une boîte donnée. Implémenté par Google en production et par un faux en test. */
export interface GmailApi {
  getProfile(email: string): Promise<{ historyId: string }>;
  listMessageIds(email: string, query: string, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }>;
  listHistory(email: string, startHistoryId: string, pageToken?: string): Promise<{ messageIds: string[]; historyId: string; nextPageToken?: string }>;
  getMessage(email: string, id: string): Promise<GmailMessage | null>;
  watch(email: string, topicName: string): Promise<{ historyId: string; expiration: Date }>;
}

export const GMAIL_API = Symbol('GMAIL_API');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

/**
 * Client Gmail par délégation au niveau du domaine Google Workspace :
 * un compte de service agit au nom de chaque employé, sans consentement individuel.
 */
export class GoogleGmailClient implements GmailApi {
  private readonly credentials: { client_email: string; private_key: string };

  constructor(serviceAccount: string) {
    const raw = serviceAccount.trim().startsWith('{') ? serviceAccount : readFileSync(serviceAccount, 'utf8');
    this.credentials = JSON.parse(raw);
  }

  private client(email: string) {
    const auth = new JWT({
      email: this.credentials.client_email,
      key: this.credentials.private_key,
      scopes: SCOPES,
      subject: email,
    });
    return gmail({ version: 'v1', auth });
  }

  async getProfile(email: string) {
    const res = await this.client(email).users.getProfile({ userId: 'me' });
    return { historyId: res.data.historyId ?? '' };
  }

  async listMessageIds(email: string, query: string, pageToken?: string) {
    const res = await this.client(email).users.messages.list({ userId: 'me', q: query, pageToken, maxResults: 200 });
    return {
      ids: (res.data.messages ?? []).map((m) => m.id!).filter(Boolean),
      nextPageToken: res.data.nextPageToken ?? undefined,
    };
  }

  async listHistory(email: string, startHistoryId: string, pageToken?: string) {
    try {
      const res = await this.client(email).users.history.list({
        userId: 'me',
        startHistoryId,
        pageToken,
        historyTypes: ['messageAdded'],
      });
      const ids = (res.data.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message?.id));
      return {
        messageIds: [...new Set(ids.filter((id): id is string => Boolean(id)))],
        historyId: res.data.historyId ?? startHistoryId,
        nextPageToken: res.data.nextPageToken ?? undefined,
      };
    } catch (e) {
      if ((e as { code?: number }).code === 404) throw new HistoryExpiredError();
      throw e;
    }
  }

  async getMessage(email: string, id: string) {
    try {
      const res = await this.client(email).users.messages.get({ userId: 'me', id, format: 'full' });
      return res.data;
    } catch (e) {
      if ((e as { code?: number }).code === 404) return null; // supprimé entre-temps
      throw e;
    }
  }

  async watch(email: string, topicName: string) {
    const res = await this.client(email).users.watch({
      userId: 'me',
      requestBody: { topicName, labelFilterBehavior: 'exclude', labelIds: ['SPAM', 'TRASH'] },
    });
    return { historyId: res.data.historyId ?? '', expiration: new Date(Number(res.data.expiration)) };
  }
}

/** Utilisé tant que le compte de service n'est pas configuré. */
export class DisabledGmailClient implements GmailApi {
  private fail(): never {
    throw new Error('Synchronisation Gmail non configurée (GOOGLE_SERVICE_ACCOUNT)');
  }
  getProfile = () => this.fail();
  listMessageIds = () => this.fail();
  listHistory = () => this.fail();
  getMessage = () => this.fail();
  watch = () => this.fail();
}

export function createGmailClient(): GmailApi {
  const serviceAccount = process.env.GOOGLE_SERVICE_ACCOUNT;
  return serviceAccount ? new GoogleGmailClient(serviceAccount) : new DisabledGmailClient();
}
