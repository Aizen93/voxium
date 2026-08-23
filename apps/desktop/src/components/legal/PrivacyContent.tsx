/**
 * The Privacy Policy text itself, without page chrome, so the same document can be
 * rendered as the public /privacy page and inside the registration
 * form's consent modal (which must not navigate away from a half-filled form —
 * and in the Tauri webview there is no "new tab" to open it in).
 *
 * Every factual claim here is meant to match the code: voice goes through
 * the mediasoup SFU (not peer-to-peer) except direct calls; DMs, secure
 * channels and their attachments are end-to-end encrypted; the retention
 * periods are the ones the scheduled sweeps enforce. Change the code, change
 * this — users accept this text at signup, and a consent to an inaccurate
 * description is a weak consent.
 */
export function PrivacyContent() {
  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold mb-2">Privacy Policy</h1>
      <p className="text-sm text-vox-text-muted mb-10">Last updated: August 23, 2026</p>

      <div className="space-y-8 text-vox-text-secondary leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">1. Data We Collect</h2>
          <p className="mb-3">We collect only what is necessary to provide the Service:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li><strong className="text-vox-text-primary">Account information</strong>, username, email address, and hashed password</li>
            <li><strong className="text-vox-text-primary">Profile data</strong>, display name, avatar, and bio you choose to provide</li>
            <li>
              <strong className="text-vox-text-primary">Messages and attachments</strong>, the text and files you send.
              Direct messages, secure channels and their attachments are end-to-end encrypted: our servers store
              and relay ciphertext they cannot read (see section 4). Messages in standard server channels are stored
              in readable form so that servers can be searched and moderated
            </li>
            <li>
              <strong className="text-vox-text-primary">Encryption keys</strong>, the <em>public</em> keys of each of
              your devices and the encrypted key material your devices exchange with each other. Private keys never
              leave your device
            </li>
            <li><strong className="text-vox-text-primary">Usage data</strong>, server memberships, channel participation, and online presence</li>
            <li>
              <strong className="text-vox-text-primary">Connection data</strong>, the IP address you register,
              sign in and connect from, with a country derived locally on our servers (no third-party lookup).
              Used solely for security and abuse prevention — detecting automated registrations, enforcing bans
              and rate limits — and deleted automatically after 180 days of inactivity
            </li>
            <li>
              <strong className="text-vox-text-primary">Consent records</strong>, the date and time at which you
              accepted the Terms of Service and this Privacy Policy
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
            <li>Preventing abuse: blocking automated registrations, enforcing bans and rate limits</li>
          </ul>
          <p className="mt-3">
            We do <strong className="text-vox-text-primary">not</strong> sell your data, serve ads, profile you, or use
            your content for training machine learning models.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">3. Voice, Video and Screen Sharing</h2>
          <p className="mb-3">
            <strong className="text-vox-text-primary">Voice channels in servers.</strong> Audio and screen-share
            video are relayed in real time through Voxium media servers (a selective forwarding unit), which is what
            lets several people talk at once. The media is encrypted in transit between your device and the server
            (DTLS-SRTP). It is processed only in memory for forwarding and is{' '}
            <strong className="text-vox-text-primary">never recorded or stored</strong>. In <em>secure</em> voice
            channels the audio is additionally end-to-end encrypted on your device, so the media server forwards
            frames it cannot decrypt.
          </p>
          <p>
            <strong className="text-vox-text-primary">Direct calls.</strong> Calls between two people are
            peer-to-peer: audio travels directly between the two devices and does not pass through our servers.
            Our servers only relay the connection-setup messages (signaling), which are themselves end-to-end
            encrypted. To establish the direct connection, your device contacts a STUN server that we host
            ourselves, which learns your public IP address for that purpose. We use no third-party STUN or TURN
            services.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">4. End-to-End Encryption</h2>
          <p className="mb-3">
            Direct messages, secure channels (text and voice) and the attachments sent in them are encrypted on your
            device with keys that only your devices and your correspondents' devices hold. Our servers store and
            relay the resulting ciphertext; they cannot read it, and neither can we. Consequences you should know:
          </p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>We cannot recover these messages for you if you lose every device and your recovery key</li>
            <li>Search in these conversations runs on your own device, not on our servers</li>
            <li>We cannot read, and therefore cannot moderate, their content. A reported direct message carries only the text the reporter provides; messages in secure channels cannot be reported at all, and a server administrator's only recourse is to delete the channel</li>
            <li>Your devices' public keys are published to our servers so that others can encrypt to you; you can verify them with the safety number shown in the app</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">5. Storage & Security</h2>
          <p>
            Your data is stored in a PostgreSQL database. Passwords are hashed using bcrypt and are never
            stored in plain text. We use JWT-based authentication with token versioning to allow session
            invalidation, and optional two-factor authentication whose secrets are encrypted at rest. File uploads
            (avatars, server icons, message attachments) are stored in S3-compatible object storage encrypted at
            rest with keys managed by the storage provider (SSE-OMK, OVHcloud-managed keys); end-to-end encrypted
            attachments are additionally stored as opaque blobs encrypted on your device.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">6. Retention</h2>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li><strong className="text-vox-text-primary">Message attachments</strong> are deleted 3 days after upload</li>
            <li><strong className="text-vox-text-primary">Connection data</strong> (IP addresses) is deleted after 180 days without activity from that address</li>
            <li><strong className="text-vox-text-primary">Accounts whose email is never verified</strong> are deleted 7 days after registration</li>
            <li><strong className="text-vox-text-primary">Undelivered encryption key material</strong> is deleted after 30 days</li>
            <li><strong className="text-vox-text-primary">Everything else</strong> is kept for as long as your account exists. Deleting your account (Settings → Security) deletes your profile, your messages, your devices' keys and your consent records with it</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">7. Legal Basis</h2>
          <p className="mb-3">Under the GDPR, we process your data on the following bases:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li><strong className="text-vox-text-primary">Performance of a contract</strong> — your account, profile, messages, presence and calls: the Service you asked for</li>
            <li><strong className="text-vox-text-primary">Legitimate interest</strong> — connection data used to keep the Service secure and prevent abuse</li>
            <li><strong className="text-vox-text-primary">Consent</strong> — recorded when you accept the Terms of Service and this Privacy Policy at registration, or later from an existing account</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">8. Third Parties</h2>
          <p>
            We do not share your personal data with third parties for marketing or advertising. Data may
            only be shared with infrastructure providers (hosting, object storage) strictly as needed to
            operate the Service. We use no third-party analytics, tracking, STUN/TURN or content delivery
            services. If you self-host Voxium, your data remains entirely under your control.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">9. Cookies & Local Storage</h2>
          <p>
            Voxium uses browser local storage for authentication tokens, user preferences (audio settings,
            mute/deaf state), UI state, and — on your device only — the encryption keys and message cache of your
            end-to-end encrypted conversations. We do not use third-party tracking cookies or analytics services.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">10. Your Rights</h2>
          <p className="mb-3">You have the right to:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>Access the personal data we hold about you</li>
            <li>Correct inaccurate information in your profile</li>
            <li>Delete your account and associated data yourself, at any time, from Settings → Security</li>
            <li>Export your data</li>
            <li>Object to processing based on our legitimate interest, and withdraw consent — withdrawing consent to this policy means closing your account, since the Service cannot operate without the data described here</li>
            <li>Lodge a complaint with your supervisory authority (in France, the CNIL)</li>
          </ul>
          <p className="mt-3">
            Since Voxium is source-available, you can also audit exactly how your data is handled by
            reviewing the source code.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">11. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. When we do, we will revise the "Last
            updated" date at the top. We encourage you to review this policy periodically. Continued use of
            the Service after changes are posted constitutes acceptance of the updated policy.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">12. Contact</h2>
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
