import { MINIMUM_AGE } from '@voxium/shared';
import { LEGAL_OPERATOR, publisherOf } from './operator';
import { MailLink } from './MailLink';

/**
 * The Terms of Service text itself, in English, without page chrome, so the
 * same document can be rendered as the public /terms page and inside the
 * registration form's consent modal (which must not navigate away from a
 * half-filled form — and in the Tauri webview there is no "new tab" to open it
 * in). TermsContent.tsx picks this file or its French translation,
 * TermsContent.fr.tsx, by the app language. The English is the reference
 * version (section 1).
 *
 * Statements about what the app lets you do (change your profile, delete your
 * account) must match the code, like the Privacy Policy's; the numbers are
 * pinned by __tests__/legal/legalFacts.test.ts. The operator's identity, the
 * contact addresses and the change notice come from operator.ts, the minimum
 * age from MINIMUM_AGE (@voxium/shared). Change this, change the French in the
 * same commit.
 */
export function TermsContentEn() {
  const publisher = publisherOf(LEGAL_OPERATOR);
  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold mb-2">Terms of Service</h1>
      <p className="text-sm text-vox-text-muted mb-10">Last updated: October 25, 2026</p>

      <div className="space-y-8 text-vox-text-secondary leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">1. Acceptance of Terms</h2>
          <p className="mb-3">
            {publisher ? (
              <>Voxium is published and operated by {publisher.name}, {publisher.address}.</>
            ) : (
              <>
                Voxium is published and operated from {LEGAL_OPERATOR.country}. The publisher&apos;s legal notice
                (identity and postal address) is available on request at{' '}
                <MailLink address={LEGAL_OPERATOR.contactEmail} />.
              </>
            )}
          </p>
          <p>
            By accessing or using Voxium ("the Service"), you agree to be bound by these Terms of Service.
            If you do not agree to these terms, you may not use the Service. We may change these terms as described
            in &ldquo;Changes to These Terms&rdquo; below. These terms are available in English and French. The
            English version is the reference version and prevails in the event of a discrepancy, except where the
            mandatory law of your country of residence requires otherwise.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">2. Accounts</h2>
          <p>
            You are responsible for maintaining the confidentiality of your account credentials and for all
            activities that occur under your account. You must provide accurate information when creating an
            account. You can change your display name, bio and avatar in the app at any time; your username and
            email address cannot be changed from the app, so contact us if either needs correcting. You must be at
            least {MINIMUM_AGE} years old to use the Service, and by creating an account you confirm that you are.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">3. Acceptable Use</h2>
          <p className="mb-3">You agree not to use the Service to:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>Violate any applicable laws or regulations</li>
            <li>Harass, abuse, or threaten other users</li>
            <li>Distribute spam, malware, or other harmful content</li>
            <li>Attempt to gain unauthorized access to the Service or other users' accounts</li>
            <li>Interfere with or disrupt the Service's infrastructure</li>
            <li>Impersonate any person or entity</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">4. Content</h2>
          <p>
            You retain ownership of content you post through the Service. By posting content, you grant
            Voxium a non-exclusive, worldwide license to store and transmit that content as necessary to
            operate the Service. You are solely responsible for the content you post and must ensure it does
            not infringe on the rights of others.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">5. Termination</h2>
          <p>
            We may suspend or terminate your account at any time if you violate these terms or engage in
            conduct that we determine is harmful to the Service or other users. You may delete your account
            yourself from Settings → Security: you confirm with your password, and with your two-factor code if it
            is turned on, and if you still own spaces, transfer or delete them first. Upon termination, your right
            to use the Service ceases immediately.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">6. Disclaimers</h2>
          <p>
            The Service is provided "as is" and "as available" without warranties of any kind, either express
            or implied. We do not guarantee that the Service will be uninterrupted, secure, or error-free.
            To the fullest extent permitted by law, Voxium disclaims liability for damages arising from your use of
            the Service. Some laws do not allow the exclusion or limitation of certain liabilities; where that is
            the case, these exclusions apply only to the extent permitted, and nothing in these terms affects the
            rights you have as a consumer under mandatory law.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">7. Changes to These Terms</h2>
          <p>
            We may revise these terms. For a material change we give at least {LEGAL_OPERATOR.changeNoticeDays}{' '}
            days&apos; notice in the app before it takes effect; a minor change, or one with no adverse effect on
            you, may take effect when it is posted. The &ldquo;Last
            updated&rdquo; date at the top shows the current version. Your continued use of the Service after a
            change takes effect is acceptance of it; if you do not agree, stop using the Service and delete your
            account (see &ldquo;Termination&rdquo; above).
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">8. Governing Law and Jurisdiction</h2>
          <p>
            These terms are governed by French law. Any dispute relating to the Service is subject to the
            jurisdiction of the French courts, unless the mandatory consumer-protection law of your country of
            residence provides otherwise.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">9. Contact</h2>
          <p>
            If you have any questions about these Terms of Service, please contact us at{' '}
            <MailLink address={LEGAL_OPERATOR.contactEmail} />.
          </p>
        </section>
      </div>
    </>
  );
}
