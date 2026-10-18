import { describe, it, expect, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { LIMITS } from '@voxium/shared';
import { translateServerError, getTranslatedError, DISCOVERY_ERROR_KEYS, WEBHOOK_ERROR_KEYS } from '../../utils/serverErrors';

/**
 * The shared validators build their messages from LIMITS; the client maps
 * those exact strings to keys whose translations say {{max}} — so the number
 * must travel with the lookup, or every language prints "{{max}}" verbatim.
 */
const t = vi.fn((key: string, opts?: Record<string, unknown>) => `${key}|${JSON.stringify(opts ?? {})}`) as unknown as TFunction;

describe('translateServerError', () => {
  it('passes the limit as {{max}} for the validator messages that carry one', () => {
    expect(translateServerError(`At most ${LIMITS.DISCOVERY_MAX_TAGS} tags are allowed`, t))
      .toBe(`serverErrors.tooManyTags|${JSON.stringify({ defaultValue: `At most ${LIMITS.DISCOVERY_MAX_TAGS} tags are allowed`, max: LIMITS.DISCOVERY_MAX_TAGS })}`);
    expect(translateServerError(`Description must be at most ${LIMITS.SERVER_DESCRIPTION_MAX} characters`, t))
      .toContain(`"max":${LIMITS.SERVER_DESCRIPTION_MAX}`);
    expect(translateServerError(`Reason must be at most ${LIMITS.SERVER_BAN_REASON_MAX} characters`, t))
      .toContain(`"max":${LIMITS.SERVER_BAN_REASON_MAX}`);
  });

  it('maps the character-set refusals without extra values', () => {
    expect(translateServerError('Description contains unsupported characters', t)).toMatch(/^serverErrors\.descriptionUnsupportedChars\|/);
    expect(translateServerError('Reason contains unsupported characters', t)).toMatch(/^serverErrors\.reasonUnsupportedChars\|/);
    expect(translateServerError('Tags must be chosen from the supported list', t)).not.toContain('"max"');
  });

  it('returns an unmapped message raw, and the fallback key for none', () => {
    expect(translateServerError('Server can have at most 20 channels', t)).toBe('Server can have at most 20 channels');
    expect(translateServerError(undefined, t)).toBe('common.somethingWentWrong|{}');
  });

  it('getTranslatedError reads an Error message through the same map', () => {
    expect(getTranslatedError(new Error('You are banned from this server'), t)).toMatch(/^serverErrors\.bannedFromServer\|/);
    expect(getTranslatedError('not an error', t, 'x.fallback')).toBe('x.fallback|{}');
  });

  it('exports every discovery key for the locale parity test, the validator ones included', () => {
    for (const key of ['descriptionUnsupportedChars', 'descriptionTooLong', 'reasonUnsupportedChars', 'reasonTooLong', 'tagsNotSupported', 'tooManyTags', 'bannedFromServer', 'cannotKickHigherRole']) {
      expect(DISCOVERY_ERROR_KEYS).toContain(key);
    }
  });
});

describe('translateServerError — incoming webhooks', () => {
  it('maps every exact string the webhook routes answer with', () => {
    const cases: Array<[string, string]> = [
      ['Webhooks are currently disabled', 'webhooksDisabled'],
      ['Webhook is disabled', 'webhookDisabled'],
      ['Webhook not found', 'webhookNotFound'],
      ['You do not have permission to manage webhooks', 'webhookNoPermission'],
      ['Webhooks can only post to text channels', 'webhookTextOnly'],
      ['Invalid webhook type', 'webhookInvalidType'],
      ['GitHub webhooks are not available yet', 'webhookGithubUnavailable'],
      ['channelId is required', 'webhookChannelRequired'],
      ['No fields to update', 'webhookNoFields'],
      ['enabled must be a boolean', 'webhookEnabledBoolean'],
      ['Webhook name cannot be empty', 'webhookNameEmpty'],
      ['Channel not found', 'channelNotFound'],
    ];
    for (const [message, key] of cases) {
      expect(translateServerError(message, t).startsWith(`serverErrors.${key}|`), message).toBe(true);
      expect(WEBHOOK_ERROR_KEYS).toContain(key);
    }
  });

  it('the shared name validator: the length message carries the limit as {{max}}', () => {
    expect(translateServerError(`Webhook name must be at most ${LIMITS.WEBHOOK_NAME_MAX} characters`, t))
      .toBe(`serverErrors.webhookNameTooLong|${JSON.stringify({ defaultValue: `Webhook name must be at most ${LIMITS.WEBHOOK_NAME_MAX} characters`, max: LIMITS.WEBHOOK_NAME_MAX })}`);
  });

  it("the per-server cap is admin-tunable: matched by pattern, the SERVER's number travels as {{max}}", () => {
    expect(translateServerError('Server can have at most 3 webhooks', t))
      .toBe(`serverErrors.webhookCap|${JSON.stringify({ defaultValue: 'Server can have at most 3 webhooks', max: 3 })}`);
    expect(translateServerError('Server can have at most 0 webhooks', t)).toContain('"max":0');
    expect(WEBHOOK_ERROR_KEYS).toContain('webhookCap');
    // anchored: a lookalike is not rewritten, and the channel cap stays raw
    expect(translateServerError('Server can have at most 3 webhooks!', t)).toBe('Server can have at most 3 webhooks!');
    expect(translateServerError('Server can have at most many webhooks', t)).toBe('Server can have at most many webhooks');
  });
});
