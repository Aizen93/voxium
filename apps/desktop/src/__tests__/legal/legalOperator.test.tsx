// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { publisherOf } from '../../components/legal/operator';
import { PRIVACY_CONTENT } from '../../components/legal/PrivacyContent';
import { TERMS_CONTENT } from '../../components/legal/TermsContent';

/**
 * operator.ts is the one place the publisher's identity is filled in. While its
 * name and address are null the Terms and the Privacy Policy offer the legal
 * notice on request (legalFacts.test.ts); once both are set, every document in
 * every language names the publisher instead. This renders the documents with
 * a filled-in operator (a made-up one: never a real identity in a test).
 */

vi.mock('../../components/legal/operator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/legal/operator')>();
  return {
    ...actual,
    LEGAL_OPERATOR: {
      ...actual.LEGAL_OPERATOR,
      publisherName: 'Example Publisher',
      publisherAddress: 'Example Street, Example City',
    },
  };
});

const text = (Document: ComponentType) =>
  renderToStaticMarkup(createElement(Document))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

describe('a publisher filled in operator.ts', () => {
  it('needs both a name and an address', () => {
    const base = { country: 'France', contactEmail: 'a@b.c', privacyEmail: 'd@e.f', changeNoticeDays: 14 };
    expect(publisherOf({ ...base, publisherName: 'X', publisherAddress: null })).toBeNull();
    expect(publisherOf({ ...base, publisherName: null, publisherAddress: 'Y' })).toBeNull();
    expect(publisherOf({ ...base, publisherName: 'X', publisherAddress: 'Y' })).toEqual({ name: 'X', address: 'Y' });
  });

  it.each([
    ['terms', 'en', 'Voxium is published and operated by Example Publisher, Example Street, Example City.'],
    ['terms', 'fr', 'Voxium est édité et exploité par Example Publisher, Example Street, Example City.'],
    ['privacy', 'en', 'The data controller is the publisher of Voxium, Example Publisher, Example Street, Example City.'],
    ['privacy', 'fr', 'Le responsable du traitement est l’éditeur de Voxium, Example Publisher, Example Street, Example City.'],
  ] as const)('the %s (%s) name the publisher instead of offering the legal notice on request', (name, lang, sentence) => {
    const rendered = text((name === 'terms' ? TERMS_CONTENT : PRIVACY_CONTENT)[lang]);
    expect(rendered).toContain(sentence);
    expect(rendered).not.toMatch(/available on request|disponibles sur demande/);
  });
});
