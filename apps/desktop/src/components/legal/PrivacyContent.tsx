/**
 * The Privacy Policy text itself, without page chrome, so the same document can be
 * rendered as the public /privacy page and inside the registration
 * form's consent modal (which must not navigate away from a half-filled form —
 * and in the Tauri webview there is no "new tab" to open it in).
 *
 * Every factual claim here is meant to match the code: server voice is relayed
 * by our media servers (not peer-to-peer) except direct calls; DMs, secure
 * channels and their attachments are end-to-end encrypted; the retention
 * periods are the ones the scheduled sweeps enforce. Change the code, change
 * this — users accept this text at signup, and a consent to an inaccurate
 * description is a weak consent.
 *
 * Every number below is pinned to the constant it describes, and the text is
 * kept free of infrastructure names (say "our servers", never the product or
 * the provider behind them), by __tests__/legal/legalFacts.test.ts.
 */
export function PrivacyContent() {
  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold mb-2">Privacy Policy</h1>
      <p className="text-sm text-vox-text-muted mb-10">Last updated: October 24, 2026</p>

      <div className="space-y-8 text-vox-text-secondary leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">1. Data We Collect</h2>
          <p className="mb-3">We collect only what is necessary to provide the Service:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>
              <strong className="text-vox-text-primary">Account information</strong>, username, email address (with a
              normalised copy of it, used only to stop one inbox from opening several accounts), and your password,
              stored hashed
            </li>
            <li>
              <strong className="text-vox-text-primary">Profile data</strong>, display name, avatar, bio and the
              per-server nicknames you choose to provide. Your profile (username, display name, avatar, bio, online
              status, a supporter badge if you have one, and the date you joined) can be seen by any other signed-in
              user
            </li>
            <li>
              <strong className="text-vox-text-primary">Messages and attachments</strong>, the text and files you send
              and the reactions you add. Direct messages, secure channels and their attachments are end-to-end
              encrypted: our servers store and relay their content as ciphertext they cannot read (see
              &ldquo;End-to-End Encryption&rdquo; below for what they can still see). Messages in standard server
              channels are stored in readable form so that servers can be searched and moderated
            </li>
            <li>
              <strong className="text-vox-text-primary">Encryption keys</strong>, the <em>public</em> keys of each of
              your devices, the encrypted key material your devices exchange with each other, and your encrypted key
              backups. Your private keys are created on your devices and never reach our servers in a form we can
              read
            </li>
            <li>
              <strong className="text-vox-text-primary">Usage data</strong>, server memberships, friends, channel
              participation, which messages you have read (for unread counts), and online presence
            </li>
            <li>
              <strong className="text-vox-text-primary">Connection data</strong>, the IP address you register,
              sign in and connect from, with a country derived on our own servers (no third-party lookup). Used for
              security and abuse prevention — detecting automated registrations, enforcing bans and rate limits —
              and, as aggregate counts of accounts per country only, for our own statistics about the Service. How
              long it is kept is set out under &ldquo;Retention&rdquo; below
            </li>
            <li>
              <strong className="text-vox-text-primary">Support and moderation records</strong>, the support
              conversations you open with us, the reports you file (with a copy of the reported message, or of the
              reported server&apos;s name and description, as it was when you reported it), reports filed about you,
              and records of the moderation and administrative actions taken on the Service
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
            <li>Displaying your profile to other signed-in users, and your messages to the people who can see the channel or conversation they are in</li>
            <li>Maintaining online presence and unread message tracking</li>
            <li>Preventing abuse: blocking automated registrations, enforcing bans and rate limits</li>
            <li>Answering your support requests and handling reports</li>
          </ul>
          <p className="mt-3">
            <strong className="text-vox-text-primary">Server directory (Explore).</strong> Servers are listed in
            Explore by default, and a server&apos;s managers can hide it at any time from its settings. A listing
            shows the server&apos;s name, icon, description, tags, join mode, creation date and member count, its
            online and weekly-message counts from the last daily check (with the time of that check), and whether
            it is featured, to signed-in users with a verified email who have accepted these terms, and nothing
            about individual members. A listing can also carry an activity badge (Bronze to Diamond), which ranks
            the server among listed servers by a score computed from those same aggregate counts. Sending a join
            request shares your public profile (username, display name, avatar) and the message you write with
            that server&apos;s moderators only (see &ldquo;Retention&rdquo; below for how long a request is kept).
          </p>
          <p className="mt-3">
            We do <strong className="text-vox-text-primary">not</strong> sell your data, serve ads, profile you, or use
            your content for training machine learning models.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">3. Voice, Video and Screen Sharing</h2>
          <p className="mb-3">
            <strong className="text-vox-text-primary">Voice channels in servers.</strong> Audio and screen-share
            video are relayed in real time through our media servers, which is what lets several people talk at
            once. The media is encrypted in transit between your device and our servers (DTLS-SRTP). It is
            processed only in memory for forwarding and is{' '}
            <strong className="text-vox-text-primary">never recorded or stored</strong>. In <em>secure</em> voice
            channels the audio is additionally end-to-end encrypted on your device, so our media servers forward
            frames they cannot decrypt. Drawings and notes added on top of a screen share (annotations) are kept on
            our servers only while the share lasts, and never more than 4 hours after the last change. Privacy masks
            you place over your own shared screen are applied on your device and never sent to us.
          </p>
          <p>
            <strong className="text-vox-text-primary">Direct calls.</strong> Calls between two people are
            peer-to-peer: audio travels directly between the two devices, encrypted between them, and does not pass
            through our servers. Because the connection is direct, each device learns the other&apos;s IP address.
            Our servers relay the connection-setup messages (signaling) without being able to read them: they are
            end-to-end encrypted to the other person&apos;s device. Our servers do know that a call took place,
            between whom, and when it started and ended. To establish the direct connection, your device contacts a
            STUN server that we host ourselves, which learns your public IP address for that purpose. We use no
            third-party STUN or TURN services.
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
            <li>
              Our servers still see who you write to and when, and the size of each message and file. Reactions (the
              emoji, who added it and to which message) are stored in readable form, and in a direct conversation the
              &ldquo;call started&rdquo; and &ldquo;call ended&rdquo; notices are stored in readable form too
            </li>
            <li>
              Copies of your keys reach our servers only sealed with keys we never receive: the keys that let a new
              device of yours read your earlier encrypted messages are uploaded sealed with your account key, which
              only your devices hold; a key backup, if you create one, is sealed with a recovery key that is never
              sent to us; and when you add a device, your other device hands it your keys end-to-end encrypted
            </li>
            <li>We cannot recover these messages for you if you lose every device and your recovery key</li>
            <li>Search in these conversations runs on your own device, not on our servers</li>
            <li>
              On your device, the keys are stored encrypted, but the messages your device has decrypted are kept in
              a local cache in readable form so that they can be displayed and searched (see the Cookie Policy) —
              anyone with access to your device account can read that cache
            </li>
            <li>We cannot read, and therefore cannot moderate, their content. A reported direct message carries only the text the reporter provides; messages in secure channels cannot be reported at all, and a server administrator's only recourse is to delete the channel</li>
            <li>Your devices' public keys are published to our servers so that others can encrypt to you; you can verify them with the safety number shown in the app</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">5. Storage & Security</h2>
          <p>
            Your data is stored on our servers. Passwords are hashed using bcrypt and are never stored in plain
            text. Sessions use signed tokens that we can revoke, and optional two-factor authentication whose
            secrets are stored encrypted and whose backup codes are stored hashed. Files you upload are kept in
            private storage: your device uploads and downloads them directly through short-lived links that our
            servers sign, and nothing in it is reachable without such a link. Avatars and server icons are served
            to anyone who has their link, and message attachments only to the people allowed to see the channel or
            conversation they were sent in. End-to-end encrypted attachments are encrypted on your device before upload, so our storage
            only ever holds them as unreadable data. Backups of our database are encrypted.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">6. Retention</h2>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>
              <strong className="text-vox-text-primary">Message attachments</strong> are deleted 3 days after the
              message they were sent with, by a daily clean-up. The message keeps the file&apos;s name, size and
              type, shown as an expired file; for an end-to-end encrypted attachment those details are inside the
              encrypted message, and our servers keep only its size
            </li>
            <li>
              <strong className="text-vox-text-primary">Connection data</strong> (IP addresses) is deleted after 180
              days without activity from that address, with two exceptions: an IP address placed on our block list
              (for example when an account is banned from Voxium) stays there for as long as the block stands; and
              our server logs, which record the IP address of each request, are rotated automatically and kept only
              for a short period
            </li>
            <li><strong className="text-vox-text-primary">Accounts whose email is never verified</strong> are deleted 7 days after registration</li>
            <li>
              <strong className="text-vox-text-primary">Join requests</strong> to a server are deleted 30 days after
              being sent if nobody has decided on them; a declined request is kept for 7 days, so the same server
              is not asked again straight away, then deleted
            </li>
            <li><strong className="text-vox-text-primary">Removals from a server</strong> are recorded as a ban on that server until one of its moderators lifts it</li>
            <li><strong className="text-vox-text-primary">Undelivered encryption key material</strong> is deleted after 30 days</li>
            <li>
              <strong className="text-vox-text-primary">Support conversations and reports</strong> have no automatic
              expiry: they are kept for support and moderation, and are deleted with the account that opened or
              filed them, or that a report concerns
            </li>
            <li>
              <strong className="text-vox-text-primary">Incoming webhooks</strong> store their name, the channel they
              post to, who created them, who last rotated their URL and when, and when they were last used; the body
              of a request a webhook receives is not kept beyond the message it produced
            </li>
            <li>
              <strong className="text-vox-text-primary">Everything else</strong> is kept for as long as your account
              exists. Deleting your account (Settings → Security) deletes with it your profile, your messages and
              reactions, your direct conversations (including the other participant&apos;s messages in them), your
              devices&apos; keys and key backups, your connection data, your support conversations and your consent
              records
            </li>
            <li>
              <strong className="text-vox-text-primary">After you delete your account</strong>, some data remains:
              records of moderation and administrative actions, no longer linked to your account (an entry can still
              hold the identifier or username it recorded); webhooks you created in a server, no longer linked to
              you; IP addresses on our block list, until the block is lifted; files you uploaded, until a daily
              clean-up removes them once nothing refers to them and they are at least 7 days old; and our server
              logs and encrypted backups, until they are replaced after a limited period
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">7. Legal Basis</h2>
          <p className="mb-3">Under the GDPR, we process your data on the following bases:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li><strong className="text-vox-text-primary">Performance of a contract</strong> — your account, profile, messages, presence and calls: the Service you asked for</li>
            <li><strong className="text-vox-text-primary">Legitimate interest</strong> — connection data used to keep the Service secure and prevent abuse, and counted per country in our own statistics; support and moderation records</li>
            <li><strong className="text-vox-text-primary">Consent</strong> — recorded when you accept the Terms of Service and this Privacy Policy at registration, or later from an existing account</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">8. Third Parties</h2>
          <p className="mb-3">
            We do not sell or share your personal data for marketing or advertising. The providers that host our
            servers and storage process data only as needed to operate the Service. Two other parties are involved:
          </p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>
              <strong className="text-vox-text-primary">Email.</strong> Account emails (address verification and
              password reset) are sent through an email delivery provider, which receives your email address and the
              message
            </li>
            <li>
              <strong className="text-vox-text-primary">App updates.</strong> When it starts, the desktop app asks
              GitHub, where our releases are published, whether a newer version exists, and downloads it from there
              if you choose to install it. GitHub sees your IP address and that request
            </li>
          </ul>
          <p className="mt-3">
            We use no third-party analytics, tracking, STUN/TURN or content delivery services. If you self-host
            Voxium, your data remains entirely under your control.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">9. Cookies & Local Storage</h2>
          <p>
            Voxium uses no tracking cookies and no analytics. To keep you signed in, the desktop app stores your
            session in the credential store of your operating system when you choose &ldquo;Remember me&rdquo;, and
            otherwise only in memory until you close the app; in a web browser, the session is kept in that
            browser&apos;s storage. The app also keeps your preferences (audio settings, mute/deaf state, UI state)
            and, on your device only, the keys and the local message cache of your end-to-end encrypted
            conversations. The Cookie Policy lists each item, where it is kept and for how long.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">10. Your Rights</h2>
          <p className="mb-3">You have the right to:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>Access the personal data we hold about you: most of it is shown in the app itself, and you can ask us for a copy of all of it by writing to the address below</li>
            <li>Receive the data you provided to us in a portable format: the app has no download for it yet, so ask us by writing to the address below</li>
            <li>Correct inaccurate information: your display name, bio and avatar can be changed in the app, and so can your server nicknames where the server allows it; to correct your username or email address, contact us</li>
            <li>Delete your account and associated data yourself, from Settings → Security. You confirm with your password, and with your two-factor code if it is turned on; if you still own servers, transfer or delete them first</li>
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
