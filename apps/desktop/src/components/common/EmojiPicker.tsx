import { useEffect, useRef, useLayoutEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import EmojiPickerReact, { Theme, EmojiStyle, Categories, type EmojiClickData, type CategoryConfig } from 'emoji-picker-react';
import type { EmojiData } from 'emoji-picker-react/dist/types/exposedTypes';
import { emojiDataLanguage, loadEmojiData } from '../../utils/emojiPickerData';

const PICKER_WIDTH = 350;
const PICKER_HEIGHT = 400;
const GAP = 8;

interface Props {
  onEmojiSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

/** The categories in the picker's own order, named by `emojiPickerLabels.category.*` */
const CATEGORY_ORDER: Categories[] = [
  Categories.SUGGESTED,
  Categories.SMILEYS_PEOPLE,
  Categories.ANIMALS_NATURE,
  Categories.FOOD_DRINK,
  Categories.TRAVEL_PLACES,
  Categories.ACTIVITIES,
  Categories.OBJECTS,
  Categories.SYMBOLS,
  Categories.FLAGS,
];

/**
 * What emoji-picker-react 4.18 lets the host translate: the category names
 * (`categories`), the preview caption (`previewConfig.defaultCaption`), the
 * search placeholder and its clear button. Its skin-tone labels, the "Show all
 * Emojis" and "Reactions" labels and the screen-reader sentences are fixed
 * English strings in 4.18. The emoji names (what the search matches) come from
 * the per-language data file when the package has one (utils/emojiPickerData).
 */
export function pickerLabels(t: (key: string) => string) {
  const categories: CategoryConfig[] = CATEGORY_ORDER.map((category) => ({ category, name: t(`emojiPickerLabels.category.${category}`) }));
  return {
    categories,
    defaultCaption: t('emojiPickerLabels.defaultCaption'),
    searchPlaceholder: t('chat.searchEmoji'),
    clearLabel: t('emojiPickerLabels.clearSearch'),
  };
}

export function EmojiPicker({ onEmojiSelect, onClose, anchorRef }: Props) {
  const { t, i18n } = useTranslation();
  const labels = pickerLabels(t);
  const dataLanguage = emojiDataLanguage(i18n?.language);
  const [emojiData, setEmojiData] = useState<{ language: string; data: EmojiData } | null>(null);

  // The emoji names of the language, fetched when the picker opens in it (a
  // chunk of its own); until it lands, or when the language has none, the
  // picker searches its English names.
  useEffect(() => {
    if (!dataLanguage) return;
    let cancelled = false;
    loadEmojiData(dataLanguage)
      .then((data) => { if (!cancelled) setEmojiData({ language: dataLanguage, data }); })
      .catch((err) => console.warn('[EmojiPicker] Could not load the emoji names:', err instanceof Error ? err.message : String(err)));
    return () => { cancelled = true; };
  }, [dataLanguage]);
  const pickerData = dataLanguage && emojiData?.language === dataLanguage ? emojiData.data : undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    // Vertical: prefer below, flip to above if not enough space
    let top: number;
    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;

    if (spaceBelow >= PICKER_HEIGHT + GAP) {
      top = rect.bottom + GAP;
    } else if (spaceAbove >= PICKER_HEIGHT + GAP) {
      top = rect.top - PICKER_HEIGHT - GAP;
    } else {
      // Neither side fits — pick the bigger side and clamp to viewport
      top = spaceBelow >= spaceAbove
        ? Math.max(GAP, vh - PICKER_HEIGHT - GAP)
        : GAP;
    }

    // Horizontal: align right edge with anchor right, clamp to viewport
    let left = rect.right - PICKER_WIDTH;
    if (left < GAP) left = GAP;
    if (left + PICKER_WIDTH > vw - GAP) left = vw - PICKER_WIDTH - GAP;

    setPosition({ top, left });
  }, [anchorRef]);

  useLayoutEffect(() => {
    updatePosition();

    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
    };
  }, [updatePosition]);

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const handleClick = (emojiData: EmojiClickData) => {
    onEmojiSelect(emojiData.emoji);
  };

  if (!position) return null;

  return createPortal(
    <div
      ref={containerRef}
      className="fixed z-50"
      style={{ top: position.top, left: position.left }}
    >
      <EmojiPickerReact
        theme={Theme.DARK}
        emojiStyle={EmojiStyle.NATIVE}
        width={PICKER_WIDTH}
        height={PICKER_HEIGHT}
        lazyLoadEmojis
        onEmojiClick={handleClick}
        searchPlaceholder={labels.searchPlaceholder}
        searchClearButtonLabel={labels.clearLabel}
        categories={labels.categories}
        previewConfig={{ defaultCaption: labels.defaultCaption }}
        emojiData={pickerData}
      />
    </div>,
    document.body
  );
}
