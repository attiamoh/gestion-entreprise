import { findCaseReferences, htmlToText, parseAddressList, parseGmailMessage } from './mime';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('parseAddressList', () => {
  it('gère les noms entre guillemets contenant une virgule', () => {
    expect(parseAddressList('"Kouassi, Ama" <Ama@Client.ci>, info@x.ci')).toEqual([
      { email: 'ama@client.ci', name: 'Kouassi, Ama' },
      { email: 'info@x.ci', name: null },
    ]);
  });
  it('ignore les valeurs vides', () => {
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList(' , ')).toEqual([]);
  });
});

describe('parseGmailMessage', () => {
  it('extrait en-têtes, corps et pièces jointes d’un message multipart', () => {
    const parsed = parseGmailMessage({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX'],
      snippet: 'Bonjour',
      internalDate: String(Date.UTC(2026, 9, 7, 9, 30)),
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'Awa Traoré <awa@client.ci>' },
          { name: 'To', value: 'commercial@alpha.ci' },
          { name: 'Cc', value: 'dg@alpha.ci' },
          { name: 'Subject', value: 'Offre [D-2026-0007]' },
          { name: 'Message-ID', value: '<abc@client.ci>' },
        ],
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: b64('Bonjour, voici notre offre.') } },
              { mimeType: 'text/html', body: { data: b64('<p>Bonjour, voici notre offre.</p>') } },
            ],
          },
          { mimeType: 'application/pdf', filename: 'offre.pdf', body: { attachmentId: 'att1', size: 1234 } },
        ],
      },
    });
    expect(parsed).toMatchObject({
      gmailMessageId: 'm1',
      gmailThreadId: 't1',
      rfcMessageId: '<abc@client.ci>',
      from: { email: 'awa@client.ci', name: 'Awa Traoré' },
      to: ['commercial@alpha.ci'],
      cc: ['dg@alpha.ci'],
      subject: 'Offre [D-2026-0007]',
      bodyText: 'Bonjour, voici notre offre.',
      attachments: [{ filename: 'offre.pdf', mimeType: 'application/pdf', size: 1234, gmailAttachmentId: 'att1' }],
    });
    expect(parsed.sentAt.toISOString()).toBe('2026-10-07T09:30:00.000Z');
  });

  it('déduit le texte du HTML quand il n’y a pas de partie texte', () => {
    const parsed = parseGmailMessage({
      id: 'm2',
      threadId: 't2',
      payload: { mimeType: 'text/html', headers: [], body: { data: b64('<div>Ligne 1<br>Ligne&nbsp;2</div><style>x{}</style>') } },
    });
    expect(parsed.bodyText).toBe('Ligne 1\nLigne 2');
    expect(parsed.subject).toBe('(sans objet)');
  });
});

describe('références de dossier', () => {
  it('trouve les références sans doublon, quelle que soit la casse', () => {
    expect(findCaseReferences('RE: d-2026-0007 et D-2026-0007, voir D-2025-12345')).toEqual(['D-2026-0007', 'D-2025-12345']);
    expect(findCaseReferences('Facture 2026-0007')).toEqual([]);
  });
  it('nettoie le HTML', () => {
    expect(htmlToText('<p>A &amp; B</p><p>C</p>')).toBe('A & B\nC');
  });
});
