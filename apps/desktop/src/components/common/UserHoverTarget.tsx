import type { ReactNode } from 'react';
import { useHoverPopup } from '../../hooks/useHoverPopup';
import { UserProfilePopup } from './UserProfilePopup';

interface Props {
  userId: string;
  children: ReactNode;
  className?: string;
}

export function UserHoverTarget({ userId, children, className }: Props) {
  const { isVisible, triggerRef, triggerProps, popupProps, close } = useHoverPopup();

  return (
    <div {...triggerProps} ref={triggerRef} className={className}>
      {children}
      {isVisible && (
        <UserProfilePopup
          userId={userId}
          anchorRef={triggerRef}
          popupProps={popupProps}
          onClose={close}
        />
      )}
    </div>
  );
}
