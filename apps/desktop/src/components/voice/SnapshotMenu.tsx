import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Camera, Clipboard, Download, Hash, Send } from 'lucide-react';
import { toast } from '../../stores/toastStore';
import type { Channel } from '@voxium/shared';
import { api } from '../../services/api';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAnnotationStore } from '../../stores/annotationStore';
import { useAnnotationLiveStore } from '../../stores/annotationLiveStore';
import { composeSnapshotCanvas, encodeSnapshot, encodeSnapshotPng } from '../../utils/shareSnapshot';

/**
 * Snapshot of the share (item 10): one button, three exits — copy to the
 * clipboard, save as a file, or send into a text channel through the EXISTING
 * attachment pipeline (presign → S3 PUT → POST message; the cleanup and
 * blob-with-row rules apply unchanged — no new server surface).
 *
 * The frame is captured the moment the button is pressed (the menu opening
 * must not change what the snapshot shows), the sharer's masks are burned in
 * (utils/shareSnapshot — never without the mask pass), and a courtesy
 * `{ k: 'snapshot' }` live event tells the sharer, always (accepted decision:
 * a viewer can screenshot their monitor anyway; the notice expresses the
 * privacy stance, it does not enforce anything).
 *
 * The channel list comes from `GET /servers/:id/channels` for the VOICE
 * server — never `serverStore.channels`, which holds the VIEWED server while
 * voice survives navigation. The server filters by VIEW_CHANNEL; secure
 * channels are excluded here (their attachments take the E2E path, v2), and
 * SEND_MESSAGES is enforced by the message POST itself.
 */

export function SnapshotMenu({
  videoRef,
  sharerName,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  sharerName: string;
}) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<HTMLCanvasElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    setSnapshot(null);
    setPos(null);
    setChannels(null);
    setPicking(false);
    setBusy(false);
  }, []);

  const reposition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    // Reposition on resize only, not scroll (project popup rule)
    window.addEventListener('resize', reposition);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('resize', reposition);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [snapshot, reposition, close]);

  const capture = () => {
    if (snapshot) {
      close();
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    const voice = useVoiceStore.getState();
    const isLocalSharing = voice.screenSharingUserId === voice.localUserId;
    const { scene, masks } = useAnnotationStore.getState();
    // THE SHARER'S MASKS ARE BURNED IN — their preview video is the raw
    // capture. Viewers' streams already carry the masks; they pass [].
    const canvas = composeSnapshotCanvas(video, scene, isLocalSharing ? masks : [], useAnnotationLiveStore.getState().fading);
    if (!canvas) {
      toast.error(t('voice.snapshot.failed'));
      return;
    }
    setSnapshot(canvas);
    reposition();
    // Courtesy notice to the sharer (their own snapshot needs no telling)
    if (!isLocalSharing) useAnnotationLiveStore.getState().notifySnapshot();
  };

  const doCopy = async () => {
    if (!snapshot || busy) return;
    setBusy(true);
    try {
      const blob = await encodeSnapshotPng(snapshot);
      if (!blob) throw new Error('PNG encode failed');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast.success(t('voice.snapshot.copied'));
      close();
    } catch (err) {
      console.warn('[Snapshot] copy failed:', err);
      toast.error(t('voice.snapshot.failed'));
      setBusy(false);
    }
  };

  const doSave = async () => {
    if (!snapshot || busy) return;
    setBusy(true);
    try {
      const blob = await encodeSnapshot(snapshot);
      if (!blob) throw new Error('encode over size cap');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `voxium-snapshot-${Date.now()}.webp`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the click a beat before the URL dies
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      close();
    } catch (err) {
      console.warn('[Snapshot] save failed:', err);
      toast.error(t('voice.snapshot.failed'));
      setBusy(false);
    }
  };

  const openPicker = async () => {
    if (picking || busy) return;
    setPicking(true);
    const serverId = useVoiceStore.getState().activeVoiceServerId;
    if (!serverId) {
      setChannels([]);
      return;
    }
    try {
      const { data } = await api.get(`/servers/${serverId}/channels`);
      const list = (data.data as Channel[]).filter((c) => c.type === 'text' && c.secure !== true);
      setChannels(list);
    } catch (err) {
      console.warn('[Snapshot] channel list failed:', err);
      setChannels([]);
    }
  };

  const doSend = async (channelId: string) => {
    if (!snapshot || busy) return;
    setBusy(true);
    try {
      const blob = await encodeSnapshot(snapshot);
      if (!blob) throw new Error('encode over size cap');
      const fileName = `voxium-snapshot-${Date.now()}.webp`;
      const { data } = await api.post('/uploads/presign/attachment', {
        fileName,
        fileSize: blob.size,
        mimeType: 'image/webp',
        channelId,
      });
      const { uploadUrl, key } = data.data as { uploadUrl: string; key: string };
      const put = await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/webp' } });
      if (!put.ok) throw new Error(`S3 snapshot upload failed: ${put.status}`);
      // The socket event is the sole source of truth for the message
      // appearing in the UI — no store append from here.
      await api.post(`/channels/${channelId}/messages`, {
        content: t('voice.snapshot.caption', { name: sharerName }),
        attachments: [{ s3Key: key, fileName, fileSize: blob.size, mimeType: 'image/webp' }],
      });
      toast.success(t('voice.snapshot.sent'));
      close();
    } catch (err) {
      console.error('[Snapshot] send failed:', err);
      toast.error(t('voice.snapshot.failed'));
      setBusy(false);
    }
  };

  const itemClass = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-vox-text-primary hover:bg-vox-bg-hover disabled:opacity-50';

  return (
    <>
      <button
        ref={buttonRef}
        onClick={capture}
        className="rounded p-1.5 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
        title={t('voice.snapshot.button')}
        aria-label={t('voice.snapshot.button')}
        data-testid="snapshot-button"
      >
        <Camera size={16} />
      </button>
      {snapshot && pos && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 w-56 rounded-lg border border-vox-border bg-vox-bg-primary p-1.5 shadow-2xl"
          style={{ top: pos.top, right: pos.right }}
          data-testid="snapshot-menu"
        >
          <button onClick={doCopy} disabled={busy} className={itemClass} data-testid="snapshot-copy">
            <Clipboard size={13} />
            {t('voice.snapshot.copy')}
          </button>
          <button onClick={doSave} disabled={busy} className={itemClass} data-testid="snapshot-save">
            <Download size={13} />
            {t('voice.snapshot.save')}
          </button>
          {!picking ? (
            <button onClick={openPicker} disabled={busy} className={itemClass} data-testid="snapshot-send-to">
              <Send size={13} />
              {t('voice.snapshot.sendTo')}
            </button>
          ) : (
            <div className="mt-1 max-h-44 overflow-y-auto border-t border-vox-border pt-1" data-testid="snapshot-channel-list">
              {channels === null ? null : channels.length === 0 ? (
                <p className="px-2 py-1 text-xs text-vox-text-muted">{t('voice.snapshot.noChannels')}</p>
              ) : (
                channels.map((c) => (
                  <button key={c.id} onClick={() => doSend(c.id)} disabled={busy} className={itemClass} data-channel-id={c.id}>
                    <Hash size={12} />
                    <span className="truncate">{c.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
