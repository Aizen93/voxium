import { useEffect } from 'react';
import { Link } from 'react-router-dom';

/**
 * What Voxium keeps on the user's device, item by item. Every row must match
 * the code that writes it: the session lives in services/tokenStorage.ts (OS
 * credential store in the desktop app, browser storage on the web), the E2E
 * vault in services/e2e/vault.ts + pickleKeyProvider.ts, and the preference
 * keys wherever `localStorage.setItem` is called. The numbers are pinned to
 * their constants, and every storage key the app writes must appear here, by
 * __tests__/legal/legalFacts.test.ts.
 */

interface StorageRow {
  item: string;
  purpose: string;
  where: string;
  duration: string;
}

const SESSION_ROWS: StorageRow[] = [
  {
    item: 'Access token',
    purpose: 'Proves to our servers that your requests come from your account',
    where: 'Desktop app: memory, and the credential store with “Remember me”. Browser: local storage with “Remember me”, session storage without',
    duration: '15 minutes, renewed automatically while you use the app',
  },
  {
    item: 'Refresh token',
    purpose: 'Renews the access token without asking for your password again',
    where: 'Same place as the access token',
    duration: 'Up to 30 days with “Remember me”, 24 hours without; replaced at each renewal and removed when you sign out',
  },
  {
    item: 'Trusted-device token',
    purpose: 'Issued when you enter a two-factor code on this device, so that your next sign-ins here skip the code',
    where: 'Desktop app: the credential store. Browser: local storage',
    duration: '30 days; kept when you sign out, removed when you turn off two-factor authentication or delete your account on this device; changing your password invalidates it',
  },
];

const ENCRYPTION_ROWS: StorageRow[] = [
  {
    item: 'Encryption vault',
    purpose: 'The keys of this device and of your end-to-end encrypted conversations, stored encrypted; and a cache of the messages this device has decrypted, kept readable so they can be displayed and searched',
    where: 'The app’s database on your device (IndexedDB), one per account, in the desktop app and in a browser',
    duration: 'Kept when you sign out, so your encrypted history stays readable when you sign back in; deleted from this device when you delete your account here',
  },
  {
    item: 'Vault key',
    purpose: 'Encrypts the keys held in the vault',
    where: 'Desktop app: the credential store. Browser: local storage',
    duration: 'Kept when you sign out; not removed automatically, even when the account is deleted (it unlocks nothing once its vault is gone)',
  },
];

const PREFERENCE_ROWS: StorageRow[] = [
  {
    item: 'voxium_language',
    purpose: 'The language of the interface',
    where: 'Local storage',
    duration: 'Until you change it',
  },
  {
    item: 'voxium_settings',
    purpose: 'Theme and custom themes, language, audio input and output devices, noise gate threshold, voice mode and quality, push-to-talk key, noise suppression, notification sounds and desktop notifications',
    where: 'Local storage',
    duration: 'Until you change them',
  },
  {
    item: 'voxium_voice_prefs',
    purpose: 'Whether you were muted or deafened, applied again when you next join a voice channel',
    where: 'Local storage',
    duration: 'Until you change it',
  },
  {
    item: 'voxium_collapsed_categories, voxium_pinned_spaces, voxium_dismissed_announcements, vox:annotations:prefs',
    purpose: 'Channel categories you collapsed, servers you pinned, announcements you dismissed, and the settings of your screen-share drawing tools',
    where: 'Local storage',
    duration: 'Until you change them',
  },
  {
    item: 'vox:maskLayouts:…, vox:securePins:… (one entry per account, named with its identifier)',
    purpose: 'Where you placed privacy masks over a shared screen, for your most recent screen sizes; and which channels this device knows to be end-to-end encrypted, so that one cannot quietly be presented to you as unencrypted',
    where: 'Local storage',
    duration: 'Kept when you sign out; the list of encrypted channels is removed when you delete your account on this device',
  },
  {
    item: 'voxium_pending_redirect',
    purpose: 'The page you were opening when you were asked to sign in, so that you land on it afterwards',
    where: 'Local storage',
    duration: 'Removed as soon as it is used',
  },
  {
    item: 'Notification pictures',
    purpose: 'Profile pictures shown in desktop notifications',
    where: 'Desktop app on Windows: a folder in your system’s temporary files',
    duration: 'Until your operating system clears its temporary files',
  },
];

function StorageTable({ caption, rows }: { caption: string; rows: StorageRow[] }) {
  return (
    <div className="rounded-lg border border-vox-border overflow-x-auto mb-4">
      <table className="w-full text-sm">
        <caption className="text-left px-4 py-2.5 text-vox-text-primary font-semibold bg-vox-bg-secondary">
          {caption}
        </caption>
        <thead>
          <tr className="bg-vox-bg-secondary">
            <th className="text-left px-4 py-2.5 text-vox-text-primary font-semibold">Data</th>
            <th className="text-left px-4 py-2.5 text-vox-text-primary font-semibold">Purpose</th>
            <th className="text-left px-4 py-2.5 text-vox-text-primary font-semibold">Where it is kept</th>
            <th className="text-left px-4 py-2.5 text-vox-text-primary font-semibold">How long</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-vox-border">
          {rows.map((row) => (
            <tr key={row.item}>
              <td className="px-4 py-2.5 align-top break-words">{row.item}</td>
              <td className="px-4 py-2.5 align-top">{row.purpose}</td>
              <td className="px-4 py-2.5 align-top">{row.where}</td>
              <td className="px-4 py-2.5 align-top">{row.duration}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CookiePolicyPage() {
  useEffect(() => {
    document.documentElement.classList.add('landing-scroll');
    window.scrollTo(0, 0);
    return () => {
      document.documentElement.classList.remove('landing-scroll');
    };
  }, []);

  return (
    <div className="min-h-screen bg-vox-bg-primary text-vox-text-primary">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-vox-bg-primary/80 backdrop-blur-md border-b border-vox-border">
        <div className="max-w-4xl mx-auto px-6 h-16 flex items-center gap-3">
          <Link to="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
            <img src="/logo.svg" alt="Voxium" className="h-8 w-8 rounded-lg" />
            <span className="text-lg font-bold text-vox-text-primary">Voxium</span>
          </Link>
          <span className="text-vox-text-muted">/</span>
          <span className="text-sm text-vox-text-secondary">Cookie Policy</span>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 pt-28 pb-16">
        <h1 className="text-3xl sm:text-4xl font-bold mb-2">Cookie Policy</h1>
        <p className="text-sm text-vox-text-muted mb-10">Last updated: October 24, 2026</p>

        <div className="space-y-8 text-vox-text-secondary leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">1. Overview</h2>
            <p>
              Voxium is committed to minimal data collection. We do{' '}
              <strong className="text-vox-text-primary">not</strong> use tracking cookies, advertising cookies,
              or analytics services, and the app sets no cookies of its own. What it keeps on your device either
              makes the app work or remembers a choice you made, and is listed below.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">2. What We Store</h2>
            <p className="mb-3">
              Where each item is kept depends on how you use Voxium. The desktop app keeps your session in the{' '}
              <strong className="text-vox-text-primary">credential store of your operating system</strong>{' '}
              (Windows Credential Manager, the macOS Keychain, or the Secret Service on Linux), and everything
              else in its own storage on your computer. In a web browser, everything is kept in that
              browser&apos;s storage for this site.
            </p>
            <StorageTable caption="Signing in" rows={SESSION_ROWS} />
            <StorageTable caption="End-to-end encryption" rows={ENCRYPTION_ROWS} />
            <StorageTable caption="Preferences and interface state" rows={PREFERENCE_ROWS} />
            <p className="mt-3 text-sm">
              Like any browser, the app may also briefly cache images and files it has displayed. None of the
              data above is used for tracking, profiling, or advertising. It is not anonymous, though: the
              session tokens identify your account to our servers, the vault holds your encryption keys and the
              messages your device has decrypted, and some preferences are stored under your account&apos;s
              identifier. The app never places your email address or your password in this storage.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">3. No Third-Party Cookies</h2>
            <p>
              Voxium does not load any third-party scripts, trackers, or analytics. There are no Google
              Analytics, Facebook Pixel, or similar services. Your browsing activity on Voxium is not shared
              with anyone. The only outside service the desktop app contacts on its own is GitHub, to check
              for updates (see the Privacy Policy).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">4. Managing Stored Data</h2>
            <p className="mb-3">
              <strong className="text-vox-text-primary">Desktop app.</strong> Signing out removes your session
              from the credential store. With &ldquo;Remember me&rdquo; off, your session is never written to
              disk: it stays in memory and ends when you close the app. Signing out keeps your trusted-device
              token, your encryption vault and your preferences, so that your encrypted history is still
              readable when you sign back in; deleting your account removes the vault and the trusted-device
              token from the device you delete it on. To remove everything from a computer, delete the
              app&apos;s data folders (named com.voxium.app) after uninstalling it, and the Voxium entries
              (their names contain app.voxium) from your operating system&apos;s credential manager.
            </p>
            <p className="mb-3">
              <strong className="text-vox-text-primary">Web browser.</strong> Clearing this site&apos;s data in
              your browser settings signs you out and removes everything listed above, your encryption vault
              included: unless another of your devices is signed in or you have a key backup, your encrypted
              history can then no longer be read in that browser.
            </p>
            <p>
              Clearing this data also resets your preferences to their defaults. Because everything here either
              makes the app work or remembers a choice you made, and none of it tracks you, there is no cookie
              consent banner.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">5. Changes to This Policy</h2>
            <p>
              If we ever introduce additional storage mechanisms, we will update this page and revise the
              "Last updated" date. We are committed to keeping client-side storage to the absolute minimum.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">6. Contact</h2>
            <p>
              For questions about this Cookie Policy, contact our Data Protection Officer at{' '}
              <a href="mailto:dpo@voxium.app" className="text-vox-accent-primary hover:underline">
                dpo@voxium.app
              </a>. For general inquiries, reach us at{' '}
              <a href="mailto:contact@voxium.app" className="text-vox-accent-primary hover:underline">
                contact@voxium.app
              </a>.
            </p>
          </section>
        </div>

        <div className="mt-12 pt-6 border-t border-vox-border">
          <Link to="/" className="text-sm text-vox-accent-primary hover:underline">
            &larr; Back to home
          </Link>
        </div>
      </main>
    </div>
  );
}
