/**
 * The Privacy Policy text itself, without page chrome, so the same document can be
 * rendered as the public /privacy page and inside the registration
 * form's consent modal (which must not navigate away from a half-filled form —
 * and in the Tauri webview there is no "new tab" to open it in).
 */
export function PrivacyContent() {
  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold mb-2">Privacy Policy</h1>
      <p className="text-sm text-vox-text-muted mb-10">Last updated: March 3, 2026</p>

      <div className="space-y-8 text-vox-text-secondary leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">1. Data We Collect</h2>
          <p className="mb-3">We collect only what is necessary to provide the Service:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li><strong className="text-vox-text-primary">Account information</strong>, username, email address, and hashed password</li>
            <li><strong className="text-vox-text-primary">Profile data</strong>, display name, avatar, and bio you choose to provide</li>
            <li><strong className="text-vox-text-primary">Messages</strong>, text messages you send through servers and direct messages</li>
            <li><strong className="text-vox-text-primary">Usage data</strong>, server memberships, channel participation, and online presence</li>
            <li>
              <strong className="text-vox-text-primary">Connection data</strong>, the IP address you register,
              sign in and connect from, with a country derived locally on our servers (no third-party lookup).
              Used solely for security and abuse prevention — detecting automated registrations, enforcing bans
              and rate limits — and deleted automatically after 180 days of inactivity
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">2. How We Use Your Data</h2>
          <p className="mb-3">Your data is used exclusively to operate and improve the Service:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>Delivering messages and enabling real-time communication</li>
            <li>Authenticating your identity and securing your account</li>
            <li>Displaying your profile to other users in shared servers and conversations</li>
            <li>Maintaining online presence and unread message tracking</li>
          </ul>
          <p className="mt-3">
            We do <strong className="text-vox-text-primary">not</strong> sell your data, serve ads, or use
            your content for training machine learning models.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">3. Voice Communication</h2>
          <p>
            Voice calls use peer-to-peer WebRTC connections. Audio data travels directly between
            participants and is <strong className="text-vox-text-primary">not</strong> routed through or
            stored on our servers. The server only handles signaling (connection setup), your actual voice
            data never touches our infrastructure.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">4. Storage & Security</h2>
          <p>
            Your data is stored in a PostgreSQL database. Passwords are hashed using bcrypt and are never
            stored in plain text. We use JWT-based authentication with token versioning to allow session
            invalidation. File uploads (avatars, server icons) are stored in S3-compatible object storage.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">5. Third Parties</h2>
          <p>
            We do not share your personal data with third parties for marketing or advertising. Data may
            only be shared with infrastructure providers (hosting, object storage) strictly as needed to
            operate the Service. If you self-host Voxium, your data remains entirely under your control.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">6. Cookies & Local Storage</h2>
          <p>
            Voxium uses browser local storage for authentication tokens, user preferences (audio settings,
            mute/deaf state), and UI state. We do not use third-party tracking cookies or analytics services.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">7. Your Rights</h2>
          <p className="mb-3">You have the right to:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>Access the personal data we hold about you</li>
            <li>Correct inaccurate information in your profile</li>
            <li>Delete your account and associated data</li>
            <li>Export your data</li>
          </ul>
          <p className="mt-3">
            Since Voxium is source-available, you can also audit exactly how your data is handled by
            reviewing the source code.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">8. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. When we do, we will revise the "Last
            updated" date at the top. We encourage you to review this policy periodically. Continued use of
            the Service after changes are posted constitutes acceptance of the updated policy.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">9. Contact</h2>
          <p>
            For questions about this Privacy Policy or to exercise your data rights, contact our Data
            Protection Officer at{' '}
            <a href="mailto:dpo@voxium.app" className="text-vox-accent-primary hover:underline">
              dpo@voxium.app
            </a>. For general inquiries, reach us at{' '}
            <a href="mailto:contact@voxium.app" className="text-vox-accent-primary hover:underline">
              contact@voxium.app
            </a>.
          </p>
        </section>
      </div>
    </>
  );
}
