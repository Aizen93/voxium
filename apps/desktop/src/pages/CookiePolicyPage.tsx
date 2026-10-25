import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CookiePolicyContent } from '../components/legal/CookiePolicyContent';

/**
 * The public /cookies page: the chrome around the Cookie Policy. The document
 * itself, what Voxium keeps on the user's device item by item, lives in
 * components/legal/CookiePolicyContent.*.tsx (English and French), where its
 * rules are written down.
 */
export function CookiePolicyPage() {
  const { t } = useTranslation();
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
          <span className="text-sm text-vox-text-secondary">{t('landing.footer.cookiePolicy')}</span>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 pt-28 pb-16">
        <CookiePolicyContent />

        <div className="mt-12 pt-6 border-t border-vox-border">
          <Link to="/" className="text-sm text-vox-accent-primary hover:underline">
            &larr; {t('landing.footer.backToHome')}
          </Link>
        </div>
      </main>
    </div>
  );
}
