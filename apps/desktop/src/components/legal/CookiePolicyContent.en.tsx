import { StorageTable, type StorageRow, type StorageTableHeaders } from './StorageTable';
import { LEGAL_OPERATOR } from './operator';
import { MailLink } from './MailLink';

/**
 * The Cookie Policy text itself, in English, without page chrome (the public
 * /cookies page, pages/CookiePolicyPage.tsx). CookiePolicyContent.tsx picks
 * this file or its French translation, CookiePolicyContent.fr.tsx, by the app
 * language.
 *
 * What Voxium keeps on the user's device, item by item. Every row must match
 * the code that writes it: the session lives in services/tokenStorage.ts (OS
 * credential store in the desktop app, browser storage on the web), the E2E
 * vault in services/e2e/vault.ts + pickleKeyProvider.ts, and the preference
 * keys wherever `localStorage.setItem` is called. The numbers are pinned to
 * their constants, and every storage key the app writes must appear here, by
 * __tests__/legal/legalFacts.test.ts. Change this, change the French in the
 * same commit: same sections, same rows, same facts, same numbers.
 */

const HEADERS: StorageTableHeaders = {
  item: 'Data',
  purpose: 'Purpose',
  where: 'Where it is kept',
  duration: 'How long',
};

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
    purpose: 'Channel categories you collapsed, spaces you pinned, announcements you dismissed, and the settings of your screen-share drawing tools',
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

export function CookiePolicyContentEn() {
  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold mb-2">Cookie Policy</h1>
      <p className="text-sm text-vox-text-muted mb-10">Last updated: October 25, 2026</p>

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
          <StorageTable caption="Signing in" headers={HEADERS} rows={SESSION_ROWS} />
          <StorageTable caption="End-to-end encryption" headers={HEADERS} rows={ENCRYPTION_ROWS} />
          <StorageTable caption="Preferences and interface state" headers={HEADERS} rows={PREFERENCE_ROWS} />
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
            For questions about this Cookie Policy, write to our privacy contact at{' '}
            <MailLink address={LEGAL_OPERATOR.privacyEmail} />. For general inquiries, reach us at{' '}
            <MailLink address={LEGAL_OPERATOR.contactEmail} />.
          </p>
        </section>
      </div>
    </>
  );
}
