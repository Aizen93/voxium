import { StorageTable, type StorageRow, type StorageTableHeaders } from './StorageTable';
import { LEGAL_OPERATOR } from './operator';
import { MailLink } from './MailLink';

/**
 * La Politique de cookies en français: the translation of
 * CookiePolicyContent.en.tsx, section by section, row by row. The English
 * file's rules apply here unchanged (every row matches the code that writes
 * it, every number is pinned, every storage key is named), and
 * __tests__/legal/legalFacts.test.ts checks this file exactly like the English
 * one, plus the same count of sections and table rows as the English and the
 * French spacing.
 *
 * The French says nothing the English does not: a change to the English is
 * made here in the same commit.
 */

const NBSP = String.fromCharCode(0x00a0);

/**
 * French spacing for the text kept in strings (JSX text writes &nbsp; itself):
 * the space before : ; ? ! and », after «, and between a number and its unit
 * must not break the line. The rows below are written with plain spaces.
 */
function frenchSpacing(text: string): string {
  return text
    .replace(/ (?=[:;?!»])/g, NBSP)
    .replace(/« /g, `«${NBSP}`)
    .replace(/(\d) (?=\p{L})/gu, `$1${NBSP}`);
}

function withFrenchSpacing(rows: StorageRow[]): StorageRow[] {
  return rows.map((row) => ({
    item: frenchSpacing(row.item),
    purpose: frenchSpacing(row.purpose),
    where: frenchSpacing(row.where),
    duration: frenchSpacing(row.duration),
  }));
}

const HEADERS: StorageTableHeaders = {
  item: 'Donnée',
  purpose: 'Finalité',
  where: 'Lieu de conservation',
  duration: 'Durée',
};

const SESSION_ROWS: StorageRow[] = withFrenchSpacing([
  {
    item: 'Jeton d’accès',
    purpose: 'Prouve à nos serveurs que vos requêtes proviennent de votre compte',
    where: 'Application de bureau : en mémoire, et dans le gestionnaire d’identifiants avec « Se souvenir de moi ». Navigateur : stockage local avec « Se souvenir de moi », stockage de session sans',
    duration: '15 minutes, renouvelé automatiquement tant que vous utilisez l’application',
  },
  {
    item: 'Jeton de rafraîchissement',
    purpose: 'Renouvelle le jeton d’accès sans vous redemander votre mot de passe',
    where: 'Au même endroit que le jeton d’accès',
    duration: 'Jusqu’à 30 jours avec « Se souvenir de moi », 24 heures sans ; remplacé à chaque renouvellement et supprimé lorsque vous vous déconnectez',
  },
  {
    item: 'Jeton d’appareil de confiance',
    purpose: 'Délivré lorsque vous saisissez un code d’authentification à deux facteurs sur cet appareil, afin que vos prochaines connexions ici se passent du code',
    where: 'Application de bureau : le gestionnaire d’identifiants. Navigateur : stockage local',
    duration: '30 jours ; conservé lorsque vous vous déconnectez, supprimé lorsque vous désactivez l’authentification à deux facteurs ou supprimez votre compte sur cet appareil ; changer votre mot de passe l’invalide',
  },
]);

const ENCRYPTION_ROWS: StorageRow[] = withFrenchSpacing([
  {
    item: 'Coffre de chiffrement',
    purpose: 'Les clés de cet appareil et de vos conversations chiffrées de bout en bout, stockées chiffrées ; et un cache des messages que cet appareil a déchiffrés, conservé lisible afin de pouvoir les afficher et y effectuer des recherches',
    where: 'La base de données de l’application sur votre appareil (IndexedDB), une par compte, dans l’application de bureau comme dans un navigateur',
    duration: 'Conservé lorsque vous vous déconnectez, afin que votre historique chiffré reste lisible lorsque vous vous reconnectez ; supprimé de cet appareil lorsque vous y supprimez votre compte',
  },
  {
    item: 'Clé du coffre',
    purpose: 'Chiffre les clés conservées dans le coffre',
    where: 'Application de bureau : le gestionnaire d’identifiants. Navigateur : stockage local',
    duration: 'Conservée lorsque vous vous déconnectez ; non supprimée automatiquement, même lorsque le compte est supprimé (elle ne déverrouille plus rien une fois son coffre supprimé)',
  },
]);

const PREFERENCE_ROWS: StorageRow[] = withFrenchSpacing([
  {
    item: 'voxium_language',
    purpose: 'La langue de l’interface',
    where: 'Stockage local',
    duration: 'Jusqu’à ce que vous la changiez',
  },
  {
    item: 'voxium_settings',
    purpose: 'Le thème et les thèmes personnalisés, la langue, les périphériques audio d’entrée et de sortie, le seuil de sensibilité du micro, le mode de saisie et la qualité vocale, la touche « Appuyer pour parler », la suppression du bruit, les sons de notification et les notifications du bureau',
    where: 'Stockage local',
    duration: 'Jusqu’à ce que vous les changiez',
  },
  {
    item: 'voxium_voice_prefs',
    purpose: 'Si votre micro ou votre son était coupé, état rétabli la prochaine fois que vous rejoindrez un salon vocal',
    where: 'Stockage local',
    duration: 'Jusqu’à ce que vous le changiez',
  },
  {
    item: 'voxium_collapsed_categories, voxium_pinned_spaces, voxium_dismissed_announcements, vox:annotations:prefs',
    purpose: 'Les catégories de salons que vous avez réduites, les espaces que vous avez épinglés, les annonces que vous avez fermées, et les réglages de vos outils de dessin du partage d’écran',
    where: 'Stockage local',
    duration: 'Jusqu’à ce que vous les changiez',
  },
  {
    item: 'vox:maskLayouts:…, vox:securePins:… (une entrée par compte, nommée avec son identifiant)',
    purpose: 'L’emplacement des masques de confidentialité que vous avez placés sur un écran partagé, pour vos tailles d’écran les plus récentes ; et les salons que cet appareil sait chiffrés de bout en bout, afin que l’un d’eux ne puisse pas vous être présenté à votre insu comme non chiffré',
    where: 'Stockage local',
    duration: 'Conservées lorsque vous vous déconnectez ; la liste des salons chiffrés est supprimée lorsque vous supprimez votre compte sur cet appareil',
  },
  {
    item: 'voxium_pending_redirect',
    purpose: 'La page que vous ouvriez lorsqu’il vous a été demandé de vous connecter, afin que vous y arriviez ensuite',
    where: 'Stockage local',
    duration: 'Supprimée dès son utilisation',
  },
  {
    item: 'Images de notification',
    purpose: 'Les photos de profil affichées dans les notifications du bureau',
    where: 'Application de bureau sous Windows : un dossier des fichiers temporaires de votre système',
    duration: 'Jusqu’à ce que votre système d’exploitation vide ses fichiers temporaires',
  },
]);

export function CookiePolicyContentFr() {
  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold mb-2">Politique de cookies</h1>
      <p className="text-sm text-vox-text-muted mb-10">Dernière mise à jour&nbsp;: 25 octobre 2026</p>

      <div className="space-y-8 text-vox-text-secondary leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">1. Présentation</h2>
          <p>
            Voxium s’engage à collecter le moins de données possible. Nous n’utilisons{' '}
            <strong className="text-vox-text-primary">aucun</strong> cookie de pistage, cookie publicitaire ni service
            de mesure d’audience, et l’application ne dépose aucun cookie qui lui soit propre. Ce qu’elle conserve sur
            votre appareil sert soit à son fonctionnement, soit à mémoriser un choix que vous avez fait, et est
            détaillé ci-dessous.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">2. Ce que nous stockons</h2>
          <p className="mb-3">
            L’endroit où chaque élément est conservé dépend de la manière dont vous utilisez Voxium. L’application de
            bureau conserve votre session dans le{' '}
            <strong className="text-vox-text-primary">gestionnaire d’identifiants de votre système d’exploitation</strong>{' '}
            (le Gestionnaire d’identification de Windows, le trousseau de macOS ou le Secret Service sous Linux), et
            tout le reste dans son propre stockage sur votre ordinateur. Dans un navigateur web, tout est conservé dans
            le stockage de ce navigateur pour ce site.
          </p>
          <StorageTable caption="Connexion" headers={HEADERS} rows={SESSION_ROWS} />
          <StorageTable caption="Chiffrement de bout en bout" headers={HEADERS} rows={ENCRYPTION_ROWS} />
          <StorageTable caption="Préférences et état de l’interface" headers={HEADERS} rows={PREFERENCE_ROWS} />
          <p className="mt-3 text-sm">
            Comme tout navigateur, l’application peut aussi garder brièvement en cache les images et les fichiers
            qu’elle a affichés. Aucune des données ci-dessus n’est utilisée à des fins de pistage, de profilage ou de
            publicité. Elles ne sont pas anonymes pour autant&nbsp;: les jetons de session identifient votre compte
            auprès de nos serveurs, le coffre contient vos clés de chiffrement et les messages que votre appareil a
            déchiffrés, et certaines préférences sont stockées sous l’identifiant de votre compte. L’application ne
            place jamais votre adresse e-mail ni votre mot de passe dans ce stockage.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">3. Aucun cookie tiers</h2>
          <p>
            Voxium ne charge aucun script, traceur ou outil de mesure d’audience tiers. Il n’y a ni Google Analytics,
            ni Facebook Pixel, ni service similaire. Votre activité de navigation sur Voxium n’est partagée avec
            personne. Le seul service extérieur que l’application de bureau contacte d’elle-même est GitHub, pour
            vérifier les mises à jour (voir la Politique de confidentialité).
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">4. Gérer les données stockées</h2>
          <p className="mb-3">
            <strong className="text-vox-text-primary">Application de bureau.</strong> La déconnexion supprime votre
            session du gestionnaire d’identifiants. Lorsque «&nbsp;Se souvenir de moi&nbsp;» est désactivé, votre
            session n’est jamais écrite sur le disque&nbsp;: elle reste en mémoire et prend fin lorsque vous fermez
            l’application. La déconnexion conserve votre jeton d’appareil de confiance, votre coffre de chiffrement et
            vos préférences, afin que votre historique chiffré reste lisible lorsque vous vous reconnectez&nbsp;; la
            suppression de votre compte supprime le coffre et le jeton d’appareil de confiance de l’appareil sur
            lequel vous le supprimez. Pour tout supprimer d’un ordinateur, supprimez les dossiers de données de
            l’application (nommés com.voxium.app) après l’avoir désinstallée, ainsi que les entrées Voxium (leur nom
            contient app.voxium) du gestionnaire d’identifiants de votre système d’exploitation.
          </p>
          <p className="mb-3">
            <strong className="text-vox-text-primary">Navigateur web.</strong> Effacer les données de ce site dans
            les paramètres de votre navigateur vous déconnecte et supprime tout ce qui est listé ci-dessus, y compris
            votre coffre de chiffrement&nbsp;: à moins qu’un autre de vos appareils ne soit connecté ou que vous ne
            disposiez d’une sauvegarde de clés, votre historique chiffré ne pourra alors plus être lu dans ce
            navigateur.
          </p>
          <p>
            Effacer ces données réinitialise également vos préférences à leurs valeurs par défaut. Comme tout ce qui
            est stocké ici sert soit au fonctionnement de l’application, soit à mémoriser un choix que vous avez fait,
            et que rien de tout cela ne vous piste, il n’y a pas de bandeau de consentement aux cookies.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">5. Modifications de la présente politique</h2>
          <p>
            Si nous introduisons un jour d’autres mécanismes de stockage, nous mettrons à jour cette page et
            modifierons la date de «&nbsp;Dernière mise à jour&nbsp;». Nous nous engageons à réduire au strict minimum
            le stockage côté client.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">6. Contact</h2>
          <p>
            Pour toute question concernant la présente Politique de cookies, écrivez à notre contact pour les
            questions de confidentialité à l’adresse <MailLink address={LEGAL_OPERATOR.privacyEmail} />. Pour toute
            demande d’ordre général, écrivez-nous à <MailLink address={LEGAL_OPERATOR.contactEmail} />.
          </p>
        </section>
      </div>
    </>
  );
}
