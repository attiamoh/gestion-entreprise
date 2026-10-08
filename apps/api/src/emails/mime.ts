import { GmailMessage } from './gmail.client';

export interface Address {
  email: string;
  name: string | null;
}

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  gmailAttachmentId: string;
}

export interface ParsedMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  rfcMessageId: string | null;
  from: Address;
  to: string[];
  cc: string[];
  subject: string;
  snippet: string;
  bodyText: string;
  bodyHtml: string | null;
  labels: string[];
  sentAt: Date;
  attachments: ParsedAttachment[];
}

type Part = NonNullable<GmailMessage['payload']>;

const decode = (data?: string | null) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

/** Découpe une liste d'adresses en respectant les guillemets : "Kouassi, Ama" <ama@x.ci>, b@y.ci */
export function parseAddressList(value: string | null | undefined): Address[] {
  if (!value) return [];
  const items: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === '<') angle = true;
    if (ch === '>') angle = false;
    if (ch === ',' && !quoted && !angle) {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map(parseAddress).filter((a): a is Address => a !== null);
}

export function parseAddress(value: string): Address | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(.*)<([^>]+)>\s*$/);
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, '').trim();
    return { email: match[2].trim().toLowerCase(), name: name || null };
  }
  return trimmed.includes('@') ? { email: trimmed.toLowerCase(), name: null } : null;
}

function walk(part: Part, out: { text: string[]; html: string[]; attachments: ParsedAttachment[] }) {
  if (part.filename && part.body?.attachmentId) {
    out.attachments.push({
      filename: part.filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      size: part.body.size ?? 0,
      gmailAttachmentId: part.body.attachmentId,
    });
    return;
  }
  if (part.mimeType === 'text/plain' && part.body?.data) out.text.push(decode(part.body.data));
  else if (part.mimeType === 'text/html' && part.body?.data) out.html.push(decode(part.body.data));
  for (const child of part.parts ?? []) walk(child, out);
}

/** Texte brut à partir du HTML, quand le message n'a pas de partie texte. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Transforme un message Gmail (format « full ») en données prêtes à enregistrer. */
export function parseGmailMessage(message: GmailMessage): ParsedMessage {
  const payload = message.payload ?? {};
  const header = (name: string) =>
    payload.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;

  const out = { text: [] as string[], html: [] as string[], attachments: [] as ParsedAttachment[] };
  walk(payload, out);
  const bodyHtml = out.html.length ? out.html.join('\n') : null;
  const bodyText = out.text.length ? out.text.join('\n') : bodyHtml ? htmlToText(bodyHtml) : '';

  const internalDate = Number(message.internalDate);
  const dateHeader = header('Date');
  const sentAt = Number.isFinite(internalDate) && internalDate > 0 ? new Date(internalDate) : new Date(dateHeader ?? Date.now());

  return {
    gmailMessageId: message.id!,
    gmailThreadId: message.threadId!,
    rfcMessageId: header('Message-ID'),
    from: parseAddressList(header('From'))[0] ?? { email: 'inconnu', name: null },
    to: parseAddressList(header('To')).map((a) => a.email),
    cc: parseAddressList(header('Cc')).map((a) => a.email),
    subject: header('Subject') ?? '(sans objet)',
    snippet: message.snippet ?? '',
    bodyText,
    bodyHtml,
    labels: message.labelIds ?? [],
    sentAt,
    attachments: out.attachments,
  };
}

/** Références de dossier citées dans un texte, ex. « Re: offre [D-2026-0012] ». */
export function findCaseReferences(text: string): string[] {
  return [...new Set((text.match(/\bD-\d{4}-\d{4,}\b/gi) ?? []).map((r) => r.toUpperCase()))];
}

/** Domaines de messagerie grand public : ils ne permettent pas d'identifier une entreprise cliente. */
export const PUBLIC_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.fr',
  'hotmail.com',
  'hotmail.fr',
  'outlook.com',
  'outlook.fr',
  'live.com',
  'live.fr',
  'icloud.com',
  'aol.com',
]);

export const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';
