import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AppWindow, Loader2 } from 'lucide-react';
import {
  acquireVaultOwnership,
  askVaultOwner,
  consumeTakeoverIntent,
  getVaultCallAtStart,
  getVaultOwnershipState,
  registerVaultOwnershipHooks,
  reloadPage,
  requestTakeoverByReload,
  requestVaultRelease,
  subscribeVaultOwnership,
  takeOverVault,
  vaultOwnershipModeOf,
  type VaultCall,
} from '../../services/e2e/vaultOwnership';
import { connectSocket, holdSocketConnections } from '../../services/socket';
import { getAccessToken } from '../../services/tokenStorage';
import { api } from '../../services/api';
import { isAuthRefusal } from '../../services/authRefusal';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';

// One page owns an account's encrypted vault (services/e2e/vaultOwnership.ts,
// docs/e2e-dm-spec.md §7.4). This gate stands in front of the app: it takes
// the vault before the app mounts (the app is what starts the E2E service and
// listens on the socket), and while another tab of the same account owns it,
// it shows a screen instead, with the socket closed. Two different accounts
// in two tabs never meet here: the vault is per account.

/**
 * What this page answers another tab that asks (which call it runs), and
 * what it does first when it gives the vault up: its calls end. The
 * ownership calls them only for the account this page is signed in to now
 * (a question about the vault of an account it signed out of is answered
 * 'none', and ends nothing). Installed when this module loads; returns the
 * uninstall.
 */
export function installVaultOwnershipHooks(): () => void {
  return registerVaultOwnershipHooks({
    liveCall: (): VaultCall => {
      const voice = useVoiceStore.getState();
      if (voice.dmCallConversationId) return 'dm';
      if (voice.activeChannelId) return 'voice';
      return 'none';
    },
    beforeLoss: () => {
      const voice = useVoiceStore.getState();
      try {
        if (voice.activeChannelId) voice.leaveChannel();
      } catch (err) {
        console.error('[VaultOwnership] Could not leave the voice channel:', err instanceof Error ? err.message : err);
      }
      try {
        if (voice.dmCallConversationId) voice.leaveDMCall();
      } catch (err) {
        console.error('[VaultOwnership] Could not leave the call:', err instanceof Error ? err.message : err);
      }
    },
  });
}
installVaultOwnershipHooks();

type View =
  | { kind: 'starting' }
  | { kind: 'owned' }
  | { kind: 'blocked' }
  | { kind: 'asking' }
  | { kind: 'confirmCall' }
  | { kind: 'releasing' }
  | { kind: 'noReply' }
  | { kind: 'opening' }
  | { kind: 'lost' };

/** Views in which this tab stays off the socket: it shows a screen, not the app. */
const OFF_SOCKET: ReadonlySet<View['kind']> = new Set(['blocked', 'asking', 'confirmCall', 'releasing', 'noReply', 'opening', 'lost']);

/** Waits between two tries of the session check when the server did not answer. */
export const SESSION_CHECK_RETRY_MS = [2_000, 5_000, 10_000, 30_000];

/** Wait `ms` before the next try, or less: the network coming back tries at once. */
function waitForRetry(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('online', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    window.addEventListener('online', done);
  });
}

/**
 * Before the app mounts in a tab that waited: is it still signed in to the
 * account it waited for? Another tab may have signed out of it meanwhile, or
 * into another account (this tab's tokens follow theirs), or deleted it.
 * Only a refusal of the session counts as signed out (isAuthRefusal, the
 * session restore's own test): a tab that waited longer than its access token
 * lives sends a stale one when its renewal fails for a passing reason (a 429,
 * a 5xx, the network), and the 401 that answers it says nothing of the
 * session. That, and no answer at all (offline, the server restarting), is
 * asked again, on a growing wait, and at once when the network comes back;
 * the screen says it is opening meanwhile.
 */
async function checkSession(userId: string): Promise<'same' | 'other' | 'gone'> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { data } = await api.get('/auth/me');
      const id = (data as { data?: { id?: unknown } } | undefined)?.data?.id;
      return id === userId ? 'same' : 'other';
    } catch (err) {
      if (isAuthRefusal(err)) return 'gone';
      console.warn('[VaultOwnership] The session could not be checked yet:', err instanceof Error ? err.message : err);
      await waitForRetry(SESSION_CHECK_RETRY_MS[Math.min(attempt, SESSION_CHECK_RETRY_MS.length - 1)]);
    }
  }
}

/**
 * The gate's state for one account, at page level like the ownership itself:
 * a remount (React's development double mount, a route change) never starts
 * a second acquisition or a second "Use it here", and never gives anything up.
 */
class GateController {
  view: View = { kind: 'starting' };
  private readonly listeners = new Set<() => void>();
  private running = false;
  private opening = false;
  /** This tab showed a screen before it owned the vault: the session is checked before the app mounts. */
  private screened = false;

  constructor(readonly userId: string) {
    subscribeVaultOwnership(() => this.follow());
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): View => this.view;

  private show(view: View): void {
    if (this.view.kind === view.kind) return;
    this.view = view;
    for (const listener of [...this.listeners]) listener();
  }

  /** The ownership changed: a vault given to this tab opens the app, a vault given up shows the screen. */
  private follow(): void {
    const state = getVaultOwnershipState(this.userId);
    if (state === 'lost') this.show({ kind: 'lost' });
    else if (state === 'owned' && this.view.kind !== 'owned' && this.view.kind !== 'starting') void this.open();
    // let go (signed out of the account): nothing of the app until it is this tab's again
    else if (state === 'none' && this.view.kind === 'owned') this.show({ kind: 'starting' });
  }

  /** Called at every mount: picks up where the page stands, and starts at most one acquisition. */
  start(): void {
    if (this.running || this.opening) return;
    const state = getVaultOwnershipState(this.userId);
    if (state === 'owned') {
      if (this.view.kind === 'starting' || !this.screened) this.show({ kind: 'owned' });
      else void this.open();
      return;
    }
    if (state === 'lost') {
      this.show({ kind: 'lost' });
      return;
    }
    if (state === 'waiting') {
      this.screened = true;
      if (this.view.kind === 'starting' || this.view.kind === 'owned') this.show({ kind: 'blocked' });
      return;
    }
    // Acquired again (a sign-in after this tab let the vault go): nothing of
    // the app until it is this tab's
    if (this.view.kind === 'owned') this.show({ kind: 'starting' });
    this.running = true;
    void this.acquire().finally(() => {
      this.running = false;
    });
  }

  private async acquire(): Promise<void> {
    // Loaded by "Use it here" in a tab that gave the vault up: ask the owner
    // instead of showing the screen again
    const intent = consumeTakeoverIntent(this.userId);
    if (intent && vaultOwnershipModeOf(this.userId) === 'fence') {
      // the newest start wins in this mode: a call running in the owner is
      // asked about first, since taking the vault over ends it
      await this.useHere();
      return;
    }
    // The wait of a tab that starts hidden is for a browser restoring several
    // tabs at once. Not in the desktop app: one instance, one window, which
    // starts hidden behind its splash screen
    const desktopApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    const outcome = await acquireVaultOwnership(this.userId, { deferWhenHidden: !intent && !desktopApp });
    if (outcome === 'owned') {
      if (this.screened) await this.open();
      else this.show({ kind: 'owned' });
      return;
    }
    if (outcome === 'lost') {
      this.show({ kind: 'lost' });
      return;
    }
    this.screened = true;
    if (intent) await this.useHere();
    // Without Web Locks a start that found a call running in the tab that
    // owns the vault waits for the person, who is told it will end
    // (claimInFenceMode); one that lost to a start written after it shows the
    // screen, like a tab finding the lock held
    else if (getVaultCallAtStart(this.userId)) this.show({ kind: 'confirmCall' });
    else this.show({ kind: 'blocked' });
  }

  /** "Use it here": ask the owner which call it runs; ask the person when one would end. */
  readonly useHere = async (): Promise<void> => {
    this.screened = true;
    this.show({ kind: 'asking' });
    const status = await askVaultOwner(this.userId);
    if (getVaultOwnershipState(this.userId) === 'owned') return; // it let go meanwhile: follow() opens
    if (this.view.kind !== 'asking') return;
    if (!status) {
      if (vaultOwnershipModeOf(this.userId) === 'fence') await this.takeOver();
      else this.show({ kind: 'noReply' });
      return;
    }
    if (status.call !== 'none') {
      this.show({ kind: 'confirmCall' });
      return;
    }
    await this.release();
  };

  /** Ask the owner to let go (its call ends), then take the vault over. */
  readonly release = async (): Promise<void> => {
    this.screened = true;
    this.show({ kind: 'releasing' });
    const outcome = await requestVaultRelease(this.userId);
    if (outcome === 'noReply') this.show({ kind: 'noReply' });
    else if (outcome === 'lost') this.show({ kind: 'lost' });
    else void this.open();
  };

  /** "Take over anyway": the owner does not answer. */
  readonly takeOver = async (): Promise<void> => {
    this.screened = true;
    this.show({ kind: 'opening' });
    const outcome = await takeOverVault(this.userId);
    if (outcome === 'lost') this.show({ kind: 'lost' });
    else void this.open();
  };

  readonly cancel = (): void => {
    this.show({ kind: 'blocked' });
  };

  /** "Use it here" in a tab that gave the vault up: a fresh page asks for it. */
  readonly reloadToUseHere = (): void => {
    requestTakeoverByReload(this.userId);
  };

  /** This tab owns the vault: the app, after a check of the session when the tab waited for it. */
  private async open(): Promise<void> {
    if (this.opening) return;
    if (!this.screened) {
      this.show({ kind: 'owned' });
      return;
    }
    this.opening = true;
    this.show({ kind: 'opening' });
    // The session the check is made with: a refusal ends that one, never
    // one another tab stores while the check runs. None (this tab's memory
    // let go: another tab signed out, or in, and this page may be reloading):
    // the sign-out then ends nothing but this tab's memory (authStore.logout)
    const sessionToken = getAccessToken();
    try {
      const verdict = await checkSession(this.userId);
      if (getVaultOwnershipState(this.userId) !== 'owned') {
        this.follow();
        return;
      }
      if (verdict === 'same') {
        this.screened = false;
        this.show({ kind: 'owned' });
      } else if (verdict === 'other') {
        // another account is signed in now: a fresh page starts as that one
        reloadPage();
      } else {
        // signed out (or the account is gone): this tab follows
        useAuthStore.getState().logout({ tellServer: false, endingSession: sessionToken });
      }
    } finally {
      this.opening = false;
    }
  }
}

const controllers = new Map<string, GateController>();

function controllerFor(userId: string): GateController {
  let controller = controllers.get(userId);
  if (!controller) {
    controller = new GateController(userId);
    controllers.set(userId, controller);
  }
  return controller;
}

/** @internal tests: forget every account's gate */
export function _resetVaultOwnershipGatesForTests(): void {
  controllers.clear();
}

/**
 * The app of `userId`, once this tab owns that account's vault; the screen
 * of a tab whose vault another tab owns otherwise. Keyed by account in App.
 */
export function VaultOwnershipGate({ userId, children }: { userId: string; children: ReactNode }) {
  const controller = controllerFor(userId);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    controller.start();
  }, [controller]);

  // Off the socket while a screen shows; back on it, with the current token,
  // when the app comes after one
  const offSocket = OFF_SOCKET.has(view.kind);
  const wasOff = useRef(false);
  useEffect(() => {
    if (!offSocket) return undefined;
    wasOff.current = true;
    return holdSocketConnections();
  }, [offSocket]);
  // after the hold above was lifted (React runs every cleanup of a commit
  // before its effects)
  useEffect(() => {
    if (view.kind !== 'owned' || !wasOff.current) return;
    wasOff.current = false;
    const token = getAccessToken();
    if (token) connectSocket(token);
  }, [view.kind]);

  if (view.kind === 'owned') return <>{children}</>;
  return <VaultOwnershipScreen view={view} controller={controller} />;
}

function VaultOwnershipScreen({ view, controller }: { view: View; controller: GateController }) {
  const { t } = useTranslation();
  if (view.kind === 'starting' || view.kind === 'owned') {
    return <div className="h-full bg-vox-bg-primary" />;
  }

  const lost = view.kind === 'lost';
  const busy = view.kind === 'asking' || view.kind === 'releasing' || view.kind === 'opening';
  const busyText =
    view.kind === 'asking' ? t('vaultOwnership.asking')
    : view.kind === 'releasing' ? t('vaultOwnership.releasing')
    : t('vaultOwnership.opening');
  const secondary =
    'flex w-full items-center justify-center gap-2 rounded-lg border border-vox-border py-2.5 text-sm text-vox-text-secondary hover:bg-vox-bg-tertiary hover:text-vox-text-primary transition-colors';

  return (
    <div className="flex h-full items-center justify-center bg-vox-bg-primary px-4">
      <div className="w-full max-w-md animate-fade-in">
        <div className="rounded-2xl border border-vox-border bg-vox-bg-secondary p-8 shadow-2xl">
          <div className="mb-6 flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-vox-accent-primary/10">
              <AppWindow size={32} className="text-vox-accent-primary" />
            </div>
            <h1 className="mt-4 text-2xl font-bold text-vox-text-primary">
              {lost ? t('vaultOwnership.lostTitle') : t('vaultOwnership.blockedTitle')}
            </h1>
            <p className="mt-2 text-sm text-vox-text-secondary">
              {lost ? t('vaultOwnership.lostBody') : t('vaultOwnership.blockedBody')}
            </p>
          </div>

          {busy && (
            <p role="status" className="flex items-center justify-center gap-2 text-sm text-vox-text-secondary">
              <Loader2 size={16} className="animate-spin" />
              {busyText}
            </p>
          )}

          {view.kind === 'confirmCall' && (
            <p role="alert" className="mb-4 rounded-lg border border-vox-accent-warning/30 bg-vox-accent-warning/10 px-4 py-3 text-sm text-vox-text-primary">
              {t('vaultOwnership.callWarning')}
            </p>
          )}

          {view.kind === 'noReply' && (
            <div role="alert" className="mb-4 rounded-lg border border-vox-accent-warning/30 bg-vox-accent-warning/10 px-4 py-3 text-sm text-vox-text-primary">
              <p>{t('vaultOwnership.noReply')}</p>
              <p className="mt-1 text-vox-text-secondary">{t('vaultOwnership.callPossible')}</p>
            </div>
          )}

          <div className="space-y-3">
            {(view.kind === 'blocked' || lost) && (
              <button
                type="button"
                onClick={lost ? controller.reloadToUseHere : () => void controller.useHere()}
                className="btn-primary flex w-full items-center justify-center gap-2 py-2.5"
              >
                {t('vaultOwnership.useHere')}
              </button>
            )}
            {view.kind === 'confirmCall' && (
              <>
                <button type="button" onClick={() => void controller.release()} className="btn-primary flex w-full items-center justify-center gap-2 py-2.5">
                  {t('vaultOwnership.useHere')}
                </button>
                <button type="button" onClick={controller.cancel} className={secondary}>
                  {t('vaultOwnership.cancel')}
                </button>
              </>
            )}
            {view.kind === 'noReply' && (
              <>
                <button type="button" onClick={() => void controller.takeOver()} className="btn-primary flex w-full items-center justify-center gap-2 py-2.5">
                  {t('vaultOwnership.takeOverAnyway')}
                </button>
                <button type="button" onClick={controller.cancel} className={secondary}>
                  {t('vaultOwnership.cancel')}
                </button>
              </>
            )}
          </div>

          {/* true with the lock only: without it (fence mode) nothing waits for the other tab */}
          {(view.kind === 'blocked' || view.kind === 'noReply') && vaultOwnershipModeOf(controller.userId) === 'lock' && (
            <p className="mt-6 text-center text-xs text-vox-text-muted">{t('vaultOwnership.waitingNote')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
