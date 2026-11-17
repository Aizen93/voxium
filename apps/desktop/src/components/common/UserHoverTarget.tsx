import { useEffect, type ReactNode } from 'react';
import { isDeletedParticipantId } from '@voxium/shared';
import { useHoverPopup } from '../../hooks/useHoverPopup';
import { onCloseProfilePopups } from '../../utils/profilePopupBus';
import { UserProfilePopup } from './UserProfilePopup';

interface Props {
  userId: string;
  children: ReactNode;
  className?: string;
}

export function UserHoverTarget({ userId, children, className }: Props) {
  // The deleted-account placeholder (`deleted:{conversationId}`) names nobody:
  // no hover card, so no profile request, member lookup or report for it
  if (isDeletedParticipantId(userId)) return <div className={className}>{children}</div>;
  return <HoverTarget userId={userId} className={className}>{children}</HoverTarget>;
}

function HoverTarget({ userId, children, className }: Props) {
  const { isVisible, triggerRef, triggerProps, popupProps, close } = useHoverPopup();

  // closed from outside when that person's account turns out to be deleted
  useEffect(() => {
    if (!isVisible) return;
    return onCloseProfilePopups((closedUserId) => {
      if (closedUserId === userId) close();
    });
  }, [isVisible, userId, close]);

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
