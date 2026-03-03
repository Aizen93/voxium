import { useEffect } from 'react';
import { Link } from 'react-router-dom';

export function TermsPage() {
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
          <span className="text-sm text-vox-text-secondary">Terms of Service</span>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 pt-28 pb-16">
        <h1 className="text-3xl sm:text-4xl font-bold mb-2">Terms of Service</h1>
        <p className="text-sm text-vox-text-muted mb-10">Last updated: March 3, 2026</p>

        <div className="space-y-8 text-vox-text-secondary leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">1. Acceptance of Terms</h2>
            <p>
              By accessing or using Voxium ("the Service"), you agree to be bound by these Terms of Service.
              If you do not agree to these terms, you may not use the Service. We reserve the right to update
              these terms at any time, and continued use of the Service constitutes acceptance of any changes.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">2. Accounts</h2>
            <p>
              You are responsible for maintaining the confidentiality of your account credentials and for all
              activities that occur under your account. You must provide accurate information when creating an
              account and promptly update it if anything changes. You must be at least 13 years old to use the
              Service.
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
              at any time. Upon termination, your right to use the Service ceases immediately.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">6. Disclaimers</h2>
            <p>
              The Service is provided "as is" and "as available" without warranties of any kind, either express
              or implied. We do not guarantee that the Service will be uninterrupted, secure, or error-free.
              To the fullest extent permitted by law, Voxium disclaims all liability for any damages arising
              from your use of the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">7. Changes to These Terms</h2>
            <p>
              We may revise these terms from time to time. When we do, we will update the "Last updated" date
              at the top of this page. We encourage you to review these terms periodically. Your continued use
              of the Service after changes are posted constitutes your acceptance of the revised terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">8. Contact</h2>
            <p>
              If you have any questions about these Terms of Service, please contact us at{' '}
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
