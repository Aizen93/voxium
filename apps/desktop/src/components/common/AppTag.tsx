import { useTranslation } from 'react-i18next';

/**
 * The APP tag next to a webhook author's name. A webhook picks its own name
 * on every post, so whoever holds its URL can post as "alice": wherever that
 * name shows (the message header, a reply quote, a search hit) the tag is
 * what tells it from the member.
 */
export function AppTag() {
  const { t } = useTranslation();
  return (
    <span
      data-testid="app-tag"
      className="inline-flex shrink-0 items-center px-1 py-0.5 rounded text-[10px] font-semibold bg-vox-accent-primary/20 text-vox-accent-primary"
    >
      {t('messageItem.appTag')}
    </span>
  );
}
