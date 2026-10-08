import { GmailApi, GmailMessage, HistoryExpiredError } from '../src/emails/gmail.client';

interface Box {
  historyId: number;
  /** Plus ancien historyId encore disponible ; en dessous, Gmail répond 404. */
  oldestHistory: number;
  messages: { historyId: number; message: GmailMessage }[];
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** Faux Gmail en mémoire, avec historique, pour tester la synchronisation sans Google. */
export class FakeGmail implements GmailApi {
  boxes = new Map<string, Box>();
  private seq = 0;

  private box(email: string) {
    let box = this.boxes.get(email);
    if (!box) {
      box = { historyId: 100, oldestHistory: 0, messages: [] };
      this.boxes.set(email, box);
    }
    return box;
  }

  /** Dépose un message dans une boîte et renvoie son identifiant Gmail. */
  deliver(email: string, m: { threadId: string; from: string; to: string; subject: string; body: string; sent?: boolean }) {
    const box = this.box(email);
    const id = `msg-${++this.seq}`;
    box.historyId += 1;
    box.messages.push({
      historyId: box.historyId,
      message: {
        id,
        threadId: m.threadId,
        labelIds: m.sent ? ['SENT'] : ['INBOX'],
        snippet: m.body.slice(0, 50),
        internalDate: String(Date.UTC(2026, 9, 7, 8, 0) + this.seq * 60_000),
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: m.from },
            { name: 'To', value: m.to },
            { name: 'Subject', value: m.subject },
          ],
          body: { data: b64(m.body) },
        },
      },
    });
    return id;
  }

  /** Simule une boîte restée trop longtemps sans synchronisation. */
  expireHistory(email: string) {
    const box = this.box(email);
    box.oldestHistory = box.historyId + 1;
  }

  async getProfile(email: string) {
    return { historyId: String(this.box(email).historyId) };
  }

  async listMessageIds(email: string) {
    return { ids: this.box(email).messages.map((m) => m.message.id!) };
  }

  async listHistory(email: string, startHistoryId: string) {
    const box = this.box(email);
    const start = Number(startHistoryId);
    if (start < box.oldestHistory) throw new HistoryExpiredError();
    return {
      messageIds: box.messages.filter((m) => m.historyId > start).map((m) => m.message.id!),
      historyId: String(box.historyId),
    };
  }

  async getMessage(email: string, id: string) {
    return this.box(email).messages.find((m) => m.message.id === id)?.message ?? null;
  }

  async watch(email: string) {
    return { historyId: String(this.box(email).historyId), expiration: new Date(Date.now() + 7 * 864e5) };
  }
}
