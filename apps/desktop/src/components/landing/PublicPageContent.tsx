import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUpRight, Heart, Laptop } from 'lucide-react';
import { ARCHITECTURE_DOCS_URL, GITHUB_CONTRIBUTORS_URL, GITHUB_SPONSORS_URL } from './publicPageLinks';
import './publicPages.css';

const githubProfile = (username: string) => `https://github.com/${encodeURIComponent(username)}`;

const flows = ['overview', 'message', 'voice', 'private'] as const;
type Flow = (typeof flows)[number];
type Action = Exclude<Flow, 'overview'>;
type ArchitectureCopy = typeof import('../../i18n/locales/en.json').landing.publicPages.architecturePage;

interface DiagramNode<Id extends string> {
  id: Id;
  actions: readonly Action[];
}

type DiagramRoute = DiagramNode<keyof ArchitectureCopy['routes']> & {
  storage?: readonly DiagramNode<keyof ArchitectureCopy['storage']>[];
};

const routes: readonly DiagramRoute[] = [
  {
    id: 'api',
    actions: ['message'],
    storage: [{ id: 'postgres', actions: ['message'] }, { id: 'objects', actions: [] }],
  },
  {
    id: 'events',
    actions: ['message', 'voice', 'private'],
    storage: [{ id: 'redis', actions: ['voice'] }],
  },
  { id: 'media', actions: ['voice'] },
  { id: 'peer', actions: ['private'] },
];

function ExternalLink({ href, children, className, label }: {
  href: string;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <a href={href} className={className ?? 'lp-public-link'} aria-label={label} target="_blank" rel="noopener noreferrer">
      {children} <ArrowUpRight aria-hidden="true" size={14} />
    </a>
  );
}

function HeroArt({ page }: { page: 'architecture' | 'contributors' }) {
  return (
    <svg className="lp-public-art" viewBox="0 0 480 245" aria-hidden="true">
      {page === 'architecture' ? (
        <>
          <defs>
            <linearGradient id="architecture-traces">
              <stop stopColor="#8670e6" stopOpacity="0" />
              <stop offset=".46" stopColor="#a98cff" />
              <stop offset="1" stopColor="#69abff" stopOpacity=".18" />
            </linearGradient>
            <pattern id="architecture-dots" width="16" height="16" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1" fill="#b8a4ff" opacity=".23" />
            </pattern>
          </defs>
          <rect x="145" y="18" width="315" height="210" fill="url(#architecture-dots)" />
          <g fill="none" stroke="url(#architecture-traces)" strokeWidth="1.2">
            <path d="M0 122H160Q181 122 192 104L229 43Q238 28 256 28H440" />
            <path d="M25 122H165Q187 122 202 109L231 84Q245 72 262 72H480" />
            <path d="M0 122H225L247 104L265 140L286 113L305 122H480" strokeWidth="2" />
            <path d="M25 122H165Q187 122 202 135L231 161Q245 173 262 173H480" />
            <path d="M0 122H160Q181 122 192 140L229 201Q238 216 256 216H440" />
          </g>
          <g fill="#a698ff">
            {[[323, 28], [395, 72], [305, 122], [345, 173], [405, 216]].map(([x, y]) => (
              <circle key={x} cx={x} cy={y} r="3" />
            ))}
          </g>
        </>
      ) : (
        <>
          <g fill="none" stroke="#8c70d7">
            <ellipse cx="335" cy="124" rx="140" ry="54" transform="rotate(-19 335 124)" opacity=".48" />
            <ellipse cx="335" cy="124" rx="111" ry="76" transform="rotate(29 335 124)" opacity=".45" />
            <ellipse cx="335" cy="124" rx="135" ry="87" transform="rotate(-19 335 124)" opacity=".23" />
            <path d="M281 67L357 48L417 130L343 175L270 150Z M281 67L343 175L357 48 M270 150L417 130" opacity=".49" />
          </g>
          <g fill="#2e2258" stroke="#ac93f2">
            {[[281, 67, 8], [357, 48, 5], [417, 130, 10], [343, 175, 8], [270, 150, 6]].map(([x, y, r]) => (
              <circle key={x} cx={x} cy={y} r={r} />
            ))}
          </g>
        </>
      )}
    </svg>
  );
}

function PageHero({ page, children }: { page: 'architecture' | 'contributors'; children?: ReactNode }) {
  const { t } = useTranslation();
  const copy = `landing.publicPages.${page}Page`;

  return (
    <header className="lp-public-hero" data-page={page}>
      <div className="lp-public-wrap">
        <HeroArt page={page} />
        <div className="lp-public-hero-copy">
          <p className="lp-public-eyebrow">
            {page === 'architecture'
              ? t('landing.publicPages.architecture')
              : t('landing.publicPages.contributorsPage.eyebrow')}
          </p>
          <h1 id="public-page-title">{t(`${copy}.title`)}<br /> <span>{t(`${copy}.highlight`)}</span></h1>
          <p className="lp-public-lede">{t(`${copy}.intro`)}</p>
          {children}
        </div>
      </div>
    </header>
  );
}

export function ArchitectureContent() {
  const { t } = useTranslation();
  const [flow, setFlow] = useState<Flow>('overview');
  const copy = 'landing.publicPages.architecturePage';
  const isHighlighted = (actions: readonly Action[]) => flow === 'overview' ? undefined : actions.includes(flow);

  return (
    <main className="lp-public-page" aria-labelledby="public-page-title">
      <PageHero page="architecture" />
      <section className="lp-public-wrap lp-public-section" aria-labelledby="connection-title">
        <div className="lp-public-section-head">
          <div>
            <h2 id="connection-title">{t(`${copy}.mapTitle`)}</h2>
            <p>{t(`${copy}.mapIntro`)}</p>
          </div>
          <ExternalLink href={ARCHITECTURE_DOCS_URL}>{t(`${copy}.docs`)}</ExternalLink>
        </div>
        <figure className="lp-public-diagram" aria-labelledby="connection-title">
          <div className="lp-public-diagram-bar">
            <strong>{t(`${copy}.mapLabel`)}</strong>
            <div className="lp-public-flow-controls" role="group" aria-label={t(`${copy}.controlLabel`)}>
              {flows.map((mode) => (
                <button type="button" key={mode} aria-pressed={flow === mode} onClick={() => setFlow(mode)}>
                  {t(`${copy}.flows.${mode}.label`)}
                </button>
              ))}
            </div>
          </div>
          <div className="lp-public-map">
            {(['client', 'connection', 'destination', 'storage'] as const).map((column) => (
              <span key={column} className="lp-public-column" aria-hidden="true">{t(`${copy}.columns.${column}`)}</span>
            ))}
            <div className="lp-public-node lp-public-device">
              <Laptop aria-hidden="true" size={38} />
              <strong>{t(`${copy}.device`)}</strong>
              <small>{t(`${copy}.deviceDetail`)}</small>
            </div>
            {routes.map((route) => {
              const active = isHighlighted(route.actions);
              return (
                <div key={route.id} className="lp-public-map-row" data-route={route.id}>
                  <div className="lp-public-port" data-active={active}>
                    <strong>{t(`${copy}.routes.${route.id}.connection`)}</strong>
                    <span className="lp-public-trace" aria-hidden="true" />
                    <small>{t(`${copy}.routes.${route.id}.transport`)}</small>
                  </div>
                  <div className="lp-public-node lp-public-destination" data-active={active}>
                    <strong>{t(`${copy}.routes.${route.id}.destination`)}</strong>
                    <small>{t(`${copy}.routes.${route.id}.detail`)}</small>
                  </div>
                  {route.storage && (
                    <div className="lp-public-node lp-public-data">
                      {route.storage.map(({ id, actions }) => (
                        <div key={id} data-active={isHighlighted(actions)}>
                          <strong>{t(`${copy}.storage.${id}.title`)}</strong>
                          <small>{t(`${copy}.storage.${id}.detail`)}</small>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <figcaption className="lp-public-diagram-detail" aria-live="polite">
            <strong>{t(`${copy}.flows.${flow}.label`)}</strong>
            <span>{t(`${copy}.flows.${flow}.detail`)}</span>
          </figcaption>
        </figure>
        <div className="lp-public-notes">
          {(['encryption', 'stun'] as const).map((note) => (
            <div key={note}>
              <h3>{t(`${copy}.notes.${note}.title`)}</h3>
              <p>{t(`${copy}.notes.${note}.detail`)}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

interface Contributor {
  username: string;
  name?: string;
  initials: string;
  avatar?: string;
  credit: 'founder' | 'pins' | 'nickname';
}

const founder: Contributor = {
  username: 'Aizen93', name: 'Oussama Aouessar', initials: 'OA', avatar: '/contributor-avatars/aizen93.jpg', credit: 'founder',
};
const contributors: readonly Contributor[] = [
  { username: 'jdotc1', name: 'Jeff', initials: 'J', avatar: '/contributor-avatars/jdotc1.jpg', credit: 'pins' },
  { username: 'XRafik', initials: 'XR', avatar: '/contributor-avatars/xrafik.png', credit: 'nickname' },
];

function ContributorAvatar({ contributor }: { contributor: Contributor }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="lp-public-avatar" aria-hidden="true">
      {contributor.initials}
      {contributor.avatar && !failed && (
        <img src={contributor.avatar} alt="" width={64} height={64} decoding="async" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

function ContributorCredit({ contributor, featured = false }: { contributor: Contributor; featured?: boolean }) {
  const { t } = useTranslation();
  const copy = 'landing.publicPages.contributorsPage';
  const credit = t(`${copy}.credits.${contributor.credit}`);
  const profileLink = (
    <ExternalLink
      href={githubProfile(contributor.username)}
      label={t(`${copy}.profileLabel`, { username: contributor.username })}
      className={featured ? 'lp-public-pill' : undefined}
    >
      {t(`${copy}.profile`)}
    </ExternalLink>
  );

  return (
    <article className={featured ? 'lp-public-founder' : 'lp-public-person'}>
      <ContributorAvatar contributor={contributor} />
      <div className="lp-public-person-copy">
        <h3><bdi>@{contributor.username}</bdi></h3>
        {contributor.name && (
          <p className="lp-public-person-name">{contributor.name}{featured && <> · {t(`${copy}.founderRole`)}</>}</p>
        )}
        <p>{credit}</p>
        {!featured && profileLink}
      </div>
      {featured && profileLink}
    </article>
  );
}

type Supporter = { id: string; name: string; github?: string } | { id: string; anonymous: true };

// Add named entries only when the supporter has approved public credit.
// Anonymous entries carry no identifying information.
const acknowledgedSupporters: readonly Supporter[] = [];

export function SupporterAcknowledgments({ showFunding, supporters }: {
  showFunding: boolean;
  supporters: readonly Supporter[];
}) {
  const { t } = useTranslation();
  const copy = 'landing.publicPages.contributorsPage';
  return (
    <section id="supporters" className="lp-public-supporters" aria-labelledby="supporters-title">
      <div className="lp-public-section-head">
        <h2 id="supporters-title">{t('landing.publicPages.supporters')}</h2>
      </div>
      <div className="lp-public-supporter-grid">
        <div className="lp-public-donor-list">
          {supporters.length ? (
            <ul>
              {supporters.map((supporter) => (
                <li key={supporter.id}>
                  {'anonymous' in supporter
                    ? t(`${copy}.anonymous`)
                    : supporter.github
                      ? <ExternalLink href={githubProfile(supporter.github)}>{supporter.name}</ExternalLink>
                      : supporter.name}
                </li>
              ))}
            </ul>
          ) : <p>{t(`${copy}.supporterPrivacy`)}</p>}
        </div>
        <div className="lp-public-thanks">
          <h3><Heart aria-hidden="true" size={17} /> {t(`${copy}.thanks`)}</h3>
          <p>{t(`${copy}.supporterImpact`)}</p>
          {showFunding && (
            <ExternalLink href={GITHUB_SPONSORS_URL} className="lp-public-pill">
              {t('landing.funding.sponsorGithub')}
            </ExternalLink>
          )}
        </div>
      </div>
    </section>
  );
}

export function ContributorsContent({ showFunding }: { showFunding: boolean }) {
  const { t } = useTranslation();
  const copy = 'landing.publicPages.contributorsPage';
  return (
    <main className="lp-public-page" aria-labelledby="public-page-title">
      <PageHero page="contributors">
        <div className="lp-public-hero-actions">
          <a className="lp-public-pill" href="#project-contributors">
            {t('landing.publicPages.contributors')} <ArrowDown aria-hidden="true" size={14} />
          </a>
          <a className="lp-public-pill" href="#supporters">
            {t('landing.publicPages.supporters')} <ArrowDown aria-hidden="true" size={14} />
          </a>
        </div>
      </PageHero>
      <div className="lp-public-wrap lp-public-section">
        <section id="project-contributors" aria-labelledby="project-contributors-title">
          <div className="lp-public-section-head">
            <h2 id="project-contributors-title">{t('landing.publicPages.contributors')}</h2>
            <ExternalLink href={GITHUB_CONTRIBUTORS_URL}>{t(`${copy}.githubContributors`)}</ExternalLink>
          </div>
          <ContributorCredit contributor={founder} featured />
          <ul className="lp-public-credits">
            {contributors.map((contributor) => (
              <li key={contributor.username}><ContributorCredit contributor={contributor} /></li>
            ))}
          </ul>
        </section>
        <SupporterAcknowledgments showFunding={showFunding} supporters={acknowledgedSupporters} />
      </div>
    </main>
  );
}
