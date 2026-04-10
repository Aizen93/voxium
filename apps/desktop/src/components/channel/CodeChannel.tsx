import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Editor, { type Monaco } from '@monaco-editor/react';
import { MonacoBinding } from 'y-monaco';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useCollabStore, getCollabDoc, getCollabProvider } from '../../stores/collabStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { CODE_LANGUAGES } from '@voxium/shared';
import { ChevronDown, Users } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { clsx } from 'clsx';
import { toast } from '../../stores/toastStore';

interface CodeChannelProps {
  channelId: string;
  serverId: string;
}

// Map our language names to Monaco language IDs
const MONACO_LANG_MAP: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  java: 'java',
  rust: 'rust',
  python: 'python',
  go: 'go',
  cpp: 'cpp',
  csharp: 'csharp',
  html: 'html',
  css: 'css',
  sql: 'sql',
  plaintext: 'plaintext',
};

// Random colors for collaborator cursors
const CURSOR_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F8C471', '#82E0AA',
];

export function CodeChannel({ channelId, serverId }: CodeChannelProps) {
  const { t } = useTranslation();
  const { joinCollab, leaveCollab, codeLanguage, setCodeLanguage, activeCollabChannelId } = useCollabStore();
  const joinChannel = useVoiceStore((s) => s.joinChannel);
  const { showMemberSidebar, toggleMemberSidebar } = useSettingsStore();
  const user = useAuthStore((s) => s.user);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  // Join collaboration when channel changes
  useEffect(() => {
    joinCollab(channelId, 'code');
    return () => {
      // Clean up binding before leaving
      if (bindingRef.current) {
        bindingRef.current.destroy();
        bindingRef.current = null;
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

  // Set up Monaco + Yjs binding when both editor and doc are ready
  const setupBinding = useCallback(() => {
    const editor = editorRef.current;
    const doc = getCollabDoc();
    const provider = getCollabProvider();

    if (!editor || !doc || !provider) return;

    // Clean up previous binding
    if (bindingRef.current) {
      bindingRef.current.destroy();
    }

    // Get or create the Y.Text for the code content
    const ytext = doc.getText('code');

    // Set up the awareness state with user info
    const colorIdx = user?.id ? user.id.charCodeAt(0) % CURSOR_COLORS.length : 0;
    provider.awareness.setLocalStateField('user', {
      name: user?.displayName || user?.username || 'Anonymous',
      color: CURSOR_COLORS[colorIdx],
    });

    // Create the binding
    const model = editor.getModel();
    if (!model) return;

    bindingRef.current = new MonacoBinding(
      ytext,
      model,
      new Set([editor]),
      provider.awareness
    );
  }, [user]);

  // Handle editor mount
  const handleEditorMount = useCallback((editor: MonacoEditor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Configure editor settings
    editor.updateOptions({
      fontSize: 14,
      lineNumbers: 'on',
      minimap: { enabled: true },
      wordWrap: 'on',
      renderWhitespace: 'selection',
      tabSize: 2,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      padding: { top: 16 },
    });

    // Try to set up binding (doc may be ready)
    setupBinding();
  }, [setupBinding]);

  // Re-attempt binding when collab state changes
  useEffect(() => {
    if (activeCollabChannelId === channelId && editorRef.current) {
      // Small delay to ensure doc/provider are ready
      const timer = setTimeout(setupBinding, 100);
      return () => clearTimeout(timer);
    }
  }, [activeCollabChannelId, channelId, setupBinding]);

  // Handle language change
  const handleLanguageChange = useCallback(async (lang: string) => {
    try {
      await setCodeLanguage(channelId, lang);

      // Update Monaco model language
      if (editorRef.current && monacoRef.current) {
        const model = editorRef.current.getModel();
        if (model) {
          monacoRef.current.editor.setModelLanguage(model, MONACO_LANG_MAP[lang] || 'plaintext');
        }
      }
    } catch {
      toast.error('Failed to change language');
    }
  }, [channelId, setCodeLanguage]);

  // Update editor language when codeLanguage changes (from remote)
  useEffect(() => {
    if (editorRef.current && monacoRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        monacoRef.current.editor.setModelLanguage(model, MONACO_LANG_MAP[codeLanguage] || 'plaintext');
      }
    }
  }, [codeLanguage]);

  const monacoLang = MONACO_LANG_MAP[codeLanguage] || 'plaintext';

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-vox-border bg-vox-bg-secondary px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-vox-text-primary">Code Editor</span>

          {/* Language selector */}
          <div className="relative">
            <select
              value={codeLanguage}
              onChange={(e) => handleLanguageChange(e.target.value)}
              className="appearance-none rounded-md border border-vox-border bg-vox-bg-tertiary px-3 py-1 pr-7 text-xs text-vox-text-primary focus:outline-none focus:border-vox-accent-primary cursor-pointer"
            >
              {CODE_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {lang.charAt(0).toUpperCase() + lang.slice(1)}
                </option>
              ))}
            </select>
            <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-vox-text-muted pointer-events-none" />
          </div>
        </div>

        <div className="flex items-center gap-2">
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

      {/* Monaco Editor */}
      <div className="flex-1">
        <Editor
          height="100%"
          language={monacoLang}
          theme="vs-dark"
          onMount={handleEditorMount}
          options={{
            automaticLayout: true,
            fontSize: 14,
            lineNumbers: 'on',
            minimap: { enabled: true },
            wordWrap: 'on',
            tabSize: 2,
            padding: { top: 16 },
          }}
        />
      </div>
    </div>
  );
}
