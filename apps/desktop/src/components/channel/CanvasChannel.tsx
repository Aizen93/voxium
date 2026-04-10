import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Tldraw,
  type Editor,
  type TLRecord,
  type TLStoreEventInfo,
} from '@tldraw/tldraw';
import '@tldraw/tldraw/tldraw.css';
import { useCollabStore, getCollabDoc } from '../../stores/collabStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { getSocket } from '../../services/socket';
import { Download, Users } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { clsx } from 'clsx';

interface CanvasChannelProps {
  channelId: string;
  serverId: string;
}

export function CanvasChannel({ channelId, serverId }: CanvasChannelProps) {
  const { t } = useTranslation();
  const { joinCollab, leaveCollab, activeCollabChannelId } = useCollabStore();
  const joinChannel = useVoiceStore((s) => s.joinChannel);
  const { showMemberSidebar, toggleMemberSidebar } = useSettingsStore();
  const editorRef = useRef<Editor | null>(null);
  const isRemoteUpdate = useRef(false);
  const storeUnsubRef = useRef<(() => void) | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // Join collaboration when channel changes
  useEffect(() => {
    joinCollab(channelId, 'canvas');
    return () => {
      // Clean up the store listener from the previous channel
      if (storeUnsubRef.current) {
        storeUnsubRef.current();
        storeUnsubRef.current = null;
      }
      leaveCollab();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Auto-join voice (voiceStore guards against duplicate/concurrent joins)
  useEffect(() => {
    joinChannel(channelId, serverId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Set up socket listeners for canvas sync
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleSync = (data: { channelId: string; update: string }) => {
      if (data.channelId !== channelId || !editorRef.current) return;

      try {
        const json = atob(data.update);
        const records: TLRecord[] = JSON.parse(json);

        if (Array.isArray(records) && records.length > 0) {
          isRemoteUpdate.current = true;
          try {
            editorRef.current.store.mergeRemoteChanges(() => {
              for (const record of records) {
                if (editorRef.current!.store.has(record.id)) {
                  editorRef.current!.store.update(record.id, () => record);
                } else {
                  editorRef.current!.store.put([record]);
                }
              }
            });
          } finally {
            isRemoteUpdate.current = false;
          }
        }
      } catch (err) {
        console.warn('[Canvas] Failed to apply remote sync:', err instanceof Error ? err.message : err);
      }
    };

    socket.on('collab:sync', handleSync);
    return () => {
      socket.off('collab:sync', handleSync);
    };
  }, [channelId]);

  // Handle editor mount — set up store change listener
  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor;

    // Clean up previous store listener if any (e.g., on re-mount)
    if (storeUnsubRef.current) {
      storeUnsubRef.current();
    }

    // Listen for local changes and broadcast them
    const unsub = editor.store.listen(
      (event: TLStoreEventInfo) => {
        if (isRemoteUpdate.current) return;
        if (event.source !== 'user') return;

        const socket = getSocket();
        if (!socket) return;

        // Collect changed records
        const changedRecords: TLRecord[] = [];
        for (const [, record] of Object.entries(event.changes.added)) {
          changedRecords.push(record);
        }
        for (const [, [, after]] of Object.entries(event.changes.updated)) {
          changedRecords.push(after);
        }

        if (changedRecords.length > 0) {
          const json = JSON.stringify(changedRecords);
          const encoded = btoa(json);
          socket.emit('collab:update', { channelId, update: encoded });
        }
      },
      { source: 'user', scope: 'document' }
    );

    storeUnsubRef.current = unsub;
  }, [channelId]);

  // Export canvas as PNG using the built-in tldraw SVG export + canvas rendering
  const handleExportSVG = useCallback(async () => {
    if (!editorRef.current || isExporting) return;
    setIsExporting(true);
    try {
      const editor = editorRef.current;
      const shapeIds = editor.getCurrentPageShapeIds();
      if (shapeIds.size === 0) return;

      // Use tldraw's getSvgElement to get an SVG of all shapes
      const svgResult = await editor.getSvgElement([...shapeIds]);
      if (!svgResult) return;

      const svgEl = svgResult.svg;
      const svgData = new XMLSerializer().serializeToString(svgEl);
      const blob = new Blob([svgData], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = 'canvas-export.svg';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[Canvas] Export failed:', err);
    } finally {
      setIsExporting(false);
    }
  }, [isExporting]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-vox-border bg-vox-bg-secondary px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-vox-text-primary">Canvas</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Export */}
          <button
            onClick={handleExportSVG}
            disabled={isExporting}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs bg-vox-bg-hover text-vox-text-secondary hover:text-vox-text-primary transition-colors disabled:opacity-50"
            title="Export as SVG"
          >
            <Download size={14} />
            Export
          </button>

          {/* Member sidebar toggle */}
          <button
            onClick={toggleMemberSidebar}
            className={clsx('rounded-md p-1.5 transition-colors', showMemberSidebar ? 'text-vox-text-primary bg-vox-bg-active' : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary')}
            title="Toggle member list"
          >
            <Users size={16} />
          </button>
        </div>
      </div>

      {/* tldraw Canvas */}
      <div className="flex-1 relative">
        <Tldraw onMount={handleMount} />
      </div>
    </div>
  );
}
