import { useEffect } from 'react';
import { Link } from 'react-router-dom';

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
        <p className="text-sm text-vox-text-muted mb-10">Last updated: March 3, 2026</p>

        <div className="space-y-8 text-vox-text-secondary leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">1. Overview</h2>
            <p>
              Voxium is committed to minimal data collection. We do{' '}
              <strong className="text-vox-text-primary">not</strong> use third-party tracking cookies,
              advertising cookies, or analytics services. The only client-side storage we use is strictly
              necessary for the application to function.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">2. What We Store</h2>
            <p className="mb-3">
              Voxium uses <strong className="text-vox-text-primary">browser local storage</strong> (not
              traditional cookies) for the following purposes:
            </p>
            <div className="rounded-lg border border-vox-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-vox-bg-secondary">
                    <th className="text-left px-4 py-2.5 text-vox-text-primary font-semibold">Data</th>
                    <th className="text-left px-4 py-2.5 text-vox-text-primary font-semibold">Purpose</th>
                    <th className="text-left px-4 py-2.5 text-vox-text-primary font-semibold">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-vox-border">
                  <tr>
                    <td className="px-4 py-2.5">Authentication token</td>
                    <td className="px-4 py-2.5">Keeps you signed in</td>
                    <td className="px-4 py-2.5">Until logout</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2.5">Voice preferences</td>
                    <td className="px-4 py-2.5">Remembers mute/deaf state</td>
                    <td className="px-4 py-2.5">Persistent</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2.5">Audio settings</td>
                    <td className="px-4 py-2.5">Input/output device, noise gate threshold</td>
                    <td className="px-4 py-2.5">Persistent</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2.5">Pending invite redirect</td>
                    <td className="px-4 py-2.5">Redirects to invite after login</td>
                    <td className="px-4 py-2.5">Single use</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm">
              All stored data is anonymous and functional — none of it is used for tracking, profiling, or
              advertising. Your email address is only stored server-side for account authentication and is
              never placed in client-side storage.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">3. No Third-Party Cookies</h2>
            <p>
              Voxium does not load any third-party scripts, trackers, or analytics. There are no Google
              Analytics, Facebook Pixel, or similar services. Your browsing activity on Voxium is not shared
              with anyone.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-vox-text-primary mb-3">4. Managing Stored Data</h2>
            <p>
              You can clear all Voxium local storage data at any time through your browser settings. Note that
              clearing this data will sign you out and reset your audio preferences to defaults. Since we only
              use strictly necessary storage, there is no cookie consent banner — these items are required for
              the application to work.
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
