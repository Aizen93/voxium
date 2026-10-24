import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PRIVACY_CONTENT } from '../../components/legal/PrivacyContent';
import { LEGAL_LANGUAGES, type LegalLanguage } from '../../components/legal/legalLanguage';

/**
 * The Privacy Policy is part of what a user consents to at signup, so its
 * factual claims must follow the code (components/legal/PrivacyContent.en.tsx:
 * "Change the code, change this"), in every language it is published in
 * (PrivacyContent.fr.tsx is its French translation). These pin the lines that
 * describe a specific mechanism, in English and in French side by side, so a
 * change to the mechanism has to touch both.
 */

/** One phrase per document language. */
type PerLanguage = Record<LegalLanguage, string>;

const PHRASES = {
  lastUpdated: { en: 'Last updated: October 24, 2026', fr: 'Dernière mise à jour : 24 octobre 2026' },
  retentionHeading: { en: 'Retention', fr: 'Conservation' },
  webhooksItem: { en: 'Incoming webhooks', fr: 'Les webhooks entrants' },
  everythingElseItem: { en: 'Everything else', fr: 'Tout le reste' },
  afterDeletionItem: { en: 'After you delete your account', fr: 'Après la suppression de votre compte' },
  // What the webhooks table holds besides its credential: name, channel,
  // creator and last-used time (routes/webhooks.ts, the list shape)
  webhookName: { en: 'their name', fr: 'conservent leur nom' },
  webhookChannel: { en: 'the channel they post to', fr: 'le salon dans lequel ils publient' },
  webhookCreator: { en: 'who created them', fr: 'qui les a créés' },
  webhookLastUsed: { en: 'when they were last used', fr: 'la date de leur dernière utilisation' },
  // The rotation trace (lastRotatedAt / lastRotatedById on the webhook row,
  // migration 20261019090000_webhook_owner_decisions) names a member too
  webhookRotation: { en: 'who last rotated their URL and when', fr: 'qui a renouvelé leur URL en dernier et quand' },
  // The execute route stores only the rendered message, never the body
  webhookBody: {
    en: 'the body of a request a webhook receives is not kept beyond the message it produced',
    fr: "le corps d'une requête reçue par un webhook n'est pas conservé au-delà du message qu'elle a produit",
  },
  // ...but the JSON access log keeps the ip, method, redacted path, status
  // and size of every delivery: the policy must not claim the whole request
  webhookWholeRequest: {
    en: 'the request a webhook receives is not kept',
    fr: "la requête reçue par un webhook n'est pas conservée",
  },
  // AuditLog.actor is onDelete: SetNull — the entries outlive the account
  auditLog: {
    en: 'records of moderation and administrative actions, no longer linked to your account',
    fr: "les traces des actions de modération et d'administration, qui ne sont plus liées à votre compte",
  },
  // IpBan rows carry no user link
  ipBans: {
    en: 'IP addresses on our block list, until the block is lifted',
    fr: "les adresses IP figurant sur notre liste de blocage, jusqu'à la levée du blocage",
  },
  // Attachments of deleted messages are reclaimed by the orphan sweep, not inline
  orphans: {
    en: 'files you uploaded, until a daily clean-up removes them',
    fr: "les fichiers que vous avez envoyés, jusqu'à ce qu'un nettoyage quotidien les supprime",
  },
  logsAndBackups: { en: 'server logs and encrypted backups', fr: 'nos journaux serveur et nos sauvegardes chiffrées' },
  // MessageReaction.emoji is a plain column; dmVoiceHandler stores DM_SYSTEM_NOTICES as plaintext rows
  reactions: {
    en: 'Reactions (the emoji, who added it and to which message) are stored in readable form',
    fr: "Les réactions (l'emoji, qui l'a ajouté et à quel message) sont stockées sous forme lisible",
  },
  callNotices: {
    en: '“call started” and “call ended” notices are stored in readable form',
    fr: '« appel commencé » et « appel terminé » sont elles aussi stockées sous forme lisible',
  },
  // GET /uploads/attachments/* is an authorized proxy: the storage link never reaches the client
  attachmentsProxied: {
    en: 'message attachments are fetched through our servers',
    fr: 'les pièces jointes des messages transitent par nos serveurs',
  },
} satisfies Record<string, PerLanguage>;

/** Rendered text as a reader sees it: no-break spaces read as plain ones, one space between words. */
const NO_BREAK_SPACE = new RegExp(String.fromCharCode(0x00a0), 'g');
function clean(text: string | null | undefined): string {
  return (text ?? '').replace(NO_BREAK_SPACE, ' ').replace(/\s+/g, ' ').trim();
}

describe.each(LEGAL_LANGUAGES)('PrivacyContent (%s)', (lang) => {
  let container: HTMLDivElement;
  let root: Root;
  const phrase = (key: keyof typeof PHRASES) => PHRASES[key][lang];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const Document = PRIVACY_CONTENT[lang];
    act(() => { root.render(<Document />); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** The section under the h2 whose text includes `title`. */
  function section(title: string): HTMLElement {
    const heading = Array.from(container.querySelectorAll('h2')).find((h) => clean(h.textContent).includes(title));
    expect(heading, `no heading containing "${title}"`).toBeTruthy();
    return heading!.parentElement!;
  }

  /** The retention list items (section 6), as their rendered text. */
  function retentionItems(): string[] {
    const list = section(phrase('retentionHeading')).querySelector('ul');
    expect(list).toBeTruthy();
    return Array.from(list!.querySelectorAll('li')).map((li) => clean(li.textContent));
  }

  it('shows the date of the last change (the audit against the code, 2026-10-24)', () => {
    expect(clean(container.textContent)).toContain(phrase('lastUpdated'));
  });

  it('says what an incoming webhook stores and that the body of an inbound request is not kept', () => {
    const line = retentionItems().find((text) => text.startsWith(phrase('webhooksItem')));
    expect(line).toBeDefined();
    for (const key of ['webhookName', 'webhookChannel', 'webhookCreator', 'webhookLastUsed', 'webhookRotation', 'webhookBody'] as const) {
      expect(line, key).toContain(phrase(key));
    }
    expect(line).not.toContain(phrase('webhookWholeRequest'));
  });

  it('says what survives an account deletion, after the catch-all "Everything else" item', () => {
    const items = retentionItems();
    const everythingElse = items.findIndex((text) => text.startsWith(phrase('everythingElseItem')));
    const after = items.findIndex((text) => text.startsWith(phrase('afterDeletionItem')));
    expect(everythingElse).toBeGreaterThanOrEqual(0);
    expect(after).toBeGreaterThan(everythingElse);
    const line = items[after];
    for (const key of ['auditLog', 'ipBans', 'orphans', 'logsAndBackups'] as const) {
      expect(line, key).toContain(phrase(key));
    }
  });

  it('says reactions and the call notices of encrypted conversations are stored readable', () => {
    const text = clean(container.textContent);
    expect(text).toContain(phrase('reactions'));
    expect(text).toContain(phrase('callNotices'));
  });

  it('says message attachments are fetched through our servers (section 5)', () => {
    expect(clean(section('5. ').textContent)).toContain(phrase('attachmentsProxied'));
  });

  it('keeps the webhook line inside the retention list, before the catch-all "Everything else" item', () => {
    const items = retentionItems();
    const webhook = items.findIndex((text) => text.startsWith(phrase('webhooksItem')));
    const everythingElse = items.findIndex((text) => text.startsWith(phrase('everythingElseItem')));
    expect(webhook).toBeGreaterThanOrEqual(0);
    expect(everythingElse).toBeGreaterThan(webhook);
  });
});
