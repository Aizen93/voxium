import { MINIMUM_AGE } from '@voxium/shared';
import { LEGAL_OPERATOR, publisherOf } from './operator';
import { MailLink } from './MailLink';

/**
 * La Politique de confidentialité en français: the translation of
 * PrivacyContent.en.tsx, section by section, sentence by sentence (the English
 * is the reference version, section 11). The English file's rules apply here
 * unchanged (every claim matches the code, every number is pinned to its
 * constant, no infrastructure names), and __tests__/legal/legalFacts.test.ts
 * checks this file exactly like the English one, plus the same shape as the
 * English (sections, paragraphs, list items, emphasis, links) and French
 * typography (a no-break space, &nbsp;, before : ; ? ! and inside « », and the
 * typographic apostrophe ’ in the text).
 *
 * The French says nothing the English does not: a change to the English is
 * made here in the same commit.
 */
export function PrivacyContentFr() {
  const publisher = publisherOf(LEGAL_OPERATOR);
  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold mb-2">Politique de confidentialité</h1>
      <p className="text-sm text-vox-text-muted mb-10">Dernière mise à jour&nbsp;: 25 octobre 2026</p>

      <div className="space-y-8 text-vox-text-secondary leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">1. Données que nous collectons</h2>
          <p className="mb-3">Nous ne collectons que ce qui est nécessaire pour fournir le Service&nbsp;:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>
              <strong className="text-vox-text-primary">Informations de compte</strong>, nom d’utilisateur, adresse
              e-mail (avec une copie normalisée de celle-ci, utilisée uniquement pour empêcher une même boîte de
              réception d’ouvrir plusieurs comptes) et votre mot de passe, stocké sous forme hachée
            </li>
            <li>
              <strong className="text-vox-text-primary">Données de profil</strong>, nom d’affichage, avatar, bio et
              les pseudos par espace que vous choisissez de fournir. Votre profil (nom d’utilisateur, nom d’affichage,
              avatar, bio, statut en ligne, un badge de supporteur si vous en avez un, et la date de votre inscription)
              peut être vu par tout autre utilisateur connecté
            </li>
            <li>
              <strong className="text-vox-text-primary">Messages et pièces jointes</strong>, le texte et les fichiers
              que vous envoyez et les réactions que vous ajoutez. Les messages privés, les salons sécurisés et leurs
              pièces jointes sont chiffrés de bout en bout&nbsp;: nos serveurs en stockent et en relaient le contenu
              sous forme chiffrée, qu’ils ne peuvent pas lire (voir «&nbsp;Chiffrement de bout en bout&nbsp;»
              ci-dessous pour ce qu’ils peuvent encore voir). Les messages des salons standard des espaces sont
              stockés sous forme lisible afin de permettre la recherche et la modération au sein des espaces
            </li>
            <li>
              <strong className="text-vox-text-primary">Clés de chiffrement</strong>, les clés <em>publiques</em> de
              chacun de vos appareils, les éléments de clé chiffrés que vos appareils échangent entre eux, et vos
              sauvegardes de clés chiffrées. Vos clés privées sont créées sur vos appareils et n’atteignent jamais nos
              serveurs sous une forme que nous pourrions lire
            </li>
            <li>
              <strong className="text-vox-text-primary">Données d’utilisation</strong>, appartenance aux espaces,
              amis, participation aux salons, messages que vous avez lus (pour le décompte des messages non lus), et
              présence en ligne
            </li>
            <li>
              <strong className="text-vox-text-primary">Données de connexion</strong>, l’adresse IP depuis laquelle
              vous vous inscrivez, ouvrez une session et vous connectez, avec un pays déduit sur nos propres serveurs
              (sans consultation d’un tiers). Elles sont utilisées pour la sécurité et la prévention des abus —
              détection des inscriptions automatisées, application des bannissements et des limites de débit — et,
              uniquement sous forme de décomptes agrégés de comptes par pays, pour nos propres statistiques sur le
              Service. Leur durée de conservation est précisée sous «&nbsp;Conservation&nbsp;» ci-dessous
            </li>
            <li>
              <strong className="text-vox-text-primary">Données de support et de modération</strong>, les
              conversations de support que vous ouvrez avec nous, les signalements que vous effectuez (avec une copie
              du message signalé, ou du nom et de la description de l’espace signalé, tels qu’ils étaient au moment de
              votre signalement), les signalements vous concernant, et les traces des actions de modération et
              d’administration effectuées sur le Service
            </li>
            <li>
              <strong className="text-vox-text-primary">Traces du consentement</strong>, la date et l’heure
              auxquelles vous avez accepté les Conditions d’utilisation et la présente Politique de confidentialité
            </li>
          </ul>
          <p className="mt-3">
            Le Service ne s’adresse pas aux personnes de moins de {MINIMUM_AGE}&nbsp;ans et nous ne collectons pas
            sciemment de données auprès d’elles.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">2. Utilisation de vos données</h2>
          <p className="mb-3">Vos données sont utilisées exclusivement pour exploiter et améliorer le Service&nbsp;:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>Acheminer les messages et permettre la communication en temps réel</li>
            <li>Authentifier votre identité et sécuriser votre compte</li>
            <li>Afficher votre profil aux autres utilisateurs connectés, et vos messages aux personnes qui peuvent voir le salon ou la conversation où ils se trouvent</li>
            <li>Gérer la présence en ligne et le suivi des messages non lus</li>
            <li>Prévenir les abus&nbsp;: bloquer les inscriptions automatisées, appliquer les bannissements et les limites de débit</li>
            <li>Répondre à vos demandes de support et traiter les signalements</li>
          </ul>
          <p className="mt-3">
            <strong className="text-vox-text-primary">Annuaire des espaces (Explorer).</strong> Les espaces sont
            répertoriés dans Explorer par défaut, et les gestionnaires d’un espace peuvent le masquer à tout moment
            depuis ses paramètres. Une fiche est visible par les utilisateurs connectés dont l’adresse e-mail est vérifiée
            et qui ont accepté les présentes conditions&nbsp;; elle présente le nom, l’icône, la description, les
            tags, le mode d’adhésion, la date de création et le nombre de membres de l’espace, ses nombres de membres
            en ligne et de messages de la semaine issus du dernier contrôle quotidien (avec l’heure de ce contrôle),
            et indique s’il est «&nbsp;À la une&nbsp;», sans rien révéler des membres individuels. Une fiche peut également
            porter un badge d’activité (de Bronze à Diamant), qui classe l’espace parmi les espaces répertoriés
            selon un score calculé à partir de ces mêmes décomptes agrégés. L’envoi d’une demande d’adhésion
            communique votre profil public (nom d’utilisateur, nom d’affichage, avatar) et le message que vous
            rédigez aux seuls modérateurs de cet espace (voir «&nbsp;Conservation&nbsp;» ci-dessous pour la durée de
            conservation d’une demande).
          </p>
          <p className="mt-3">
            Nous ne vendons <strong className="text-vox-text-primary">pas</strong> vos données, nous ne diffusons pas
            de publicité, nous ne faisons pas de profilage à votre sujet et nous n’utilisons pas votre contenu pour
            entraîner des modèles d’apprentissage automatique.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">3. Voix, vidéo et partage d’écran</h2>
          <p className="mb-3">
            <strong className="text-vox-text-primary">Salons vocaux des espaces.</strong> L’audio et la vidéo des
            partages d’écran sont relayés en temps réel par nos serveurs multimédias, ce qui permet à plusieurs
            personnes de parler en même temps. Les flux sont chiffrés en transit entre votre appareil et nos serveurs
            (DTLS-SRTP). Ils ne sont traités qu’en mémoire, pour être retransmis, et ne sont{' '}
            <strong className="text-vox-text-primary">jamais enregistrés ni stockés</strong>. Dans les salons vocaux{' '}
            <em>sécurisés</em>, l’audio est en outre chiffré de bout en bout sur votre appareil, de sorte que nos
            serveurs multimédias retransmettent des trames qu’ils ne peuvent pas déchiffrer. Les dessins et les notes
            ajoutés par-dessus un partage d’écran (annotations) ne sont conservés sur nos serveurs que pendant la
            durée du partage, et jamais plus de 4&nbsp;heures après la dernière modification. Les masques de
            confidentialité que vous placez sur votre propre écran partagé sont appliqués sur votre appareil et ne
            nous sont jamais envoyés.
          </p>
          <p>
            <strong className="text-vox-text-primary">Appels directs.</strong> Les appels entre deux personnes se
            font en pair-à-pair&nbsp;: l’audio circule directement entre les deux appareils, chiffré entre eux, et ne
            transite pas par nos serveurs. La connexion étant directe, chaque appareil apprend l’adresse IP de
            l’autre. Nos serveurs relaient les messages d’établissement de la connexion (signalisation) sans pouvoir
            les lire&nbsp;: ils sont chiffrés de bout en bout à destination de l’appareil de l’autre personne. Nos
            serveurs savent en revanche qu’un appel a eu lieu, entre qui, et quand il a commencé et pris fin. Pour
            établir la connexion directe, votre appareil contacte un serveur STUN que nous hébergeons nous-mêmes, qui
            apprend votre adresse IP publique à cette fin. Nous n’utilisons aucun service STUN ou TURN tiers.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">4. Chiffrement de bout en bout</h2>
          <p className="mb-3">
            Les messages privés, les salons sécurisés (textuels et vocaux) et les pièces jointes qui y sont envoyées
            sont chiffrés sur votre appareil avec des clés que seuls vos appareils et ceux de vos correspondants
            détiennent. Nos serveurs stockent et relaient le contenu chiffré qui en résulte&nbsp;; ils ne peuvent pas
            le lire, et nous non plus. Les conséquences à connaître&nbsp;:
          </p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>
              Nos serveurs voient toujours à qui vous écrivez et quand, ainsi que la taille de chaque message et de
              chaque fichier. Les réactions (l’emoji, qui l’a ajouté et à quel message) sont stockées sous forme
              lisible, et dans une conversation privée, les mentions «&nbsp;appel commencé&nbsp;» et «&nbsp;appel
              terminé&nbsp;» sont elles aussi stockées sous forme lisible
            </li>
            <li>
              Des copies de vos clés n’atteignent nos serveurs que scellées avec des clés que nous ne recevons
              jamais&nbsp;: les clés qui permettent à un nouvel appareil vous appartenant de lire vos messages chiffrés
              antérieurs sont envoyées scellées avec votre clé de compte, que seuls vos appareils détiennent&nbsp;; une
              sauvegarde de clés, si vous en créez une, est scellée avec une clé de récupération qui ne nous est jamais
              envoyée&nbsp;; et lorsque vous ajoutez un appareil, votre autre appareil lui transmet vos clés, chiffrées
              de bout en bout
            </li>
            <li>Nous ne pouvons pas récupérer ces messages pour vous si vous perdez tous vos appareils et votre clé de récupération</li>
            <li>La recherche dans ces conversations s’effectue sur votre propre appareil, et non sur nos serveurs</li>
            <li>
              Sur votre appareil, les clés sont stockées chiffrées, mais les messages que votre appareil a déchiffrés
              sont conservés sous forme lisible dans un cache local afin de pouvoir être affichés et recherchés (voir la
              Politique de cookies) — toute personne ayant accès à votre compte utilisateur sur cet appareil peut lire
              ce cache
            </li>
            <li>Nous ne pouvons pas lire leur contenu, et ne pouvons donc pas le modérer. Un message privé signalé ne comporte que le texte fourni par l’auteur du signalement&nbsp;; les messages des salons sécurisés ne peuvent pas être signalés du tout, et le seul recours d’un administrateur d’espace est de supprimer le salon</li>
            <li>Les clés publiques de vos appareils sont publiées sur nos serveurs afin que d’autres puissent chiffrer à votre intention&nbsp;; vous pouvez les vérifier grâce au numéro de sécurité affiché dans l’application</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">5. Stockage et sécurité</h2>
          <p>
            Vos données sont stockées sur nos serveurs. Les mots de passe sont hachés avec bcrypt et ne sont jamais
            stockés en clair. Les sessions reposent sur des jetons signés que nous pouvons révoquer et sur une
            authentification à deux facteurs facultative, dont les secrets sont stockés chiffrés et les codes de
            secours stockés hachés. Les fichiers que vous envoyez sont conservés dans un stockage privé dont rien n’est
            accessible sans un lien signé par nos serveurs&nbsp;: votre appareil les envoie directement au moyen d’un
            tel lien, à durée de vie limitée. Les avatars et les icônes d’espace sont servis à toute personne qui en
            possède le lien&nbsp;; les pièces jointes des messages transitent par nos serveurs, qui ne les remettent
            qu’aux personnes autorisées à voir le salon ou la conversation dans lesquels elles ont été envoyées. Les
            pièces jointes chiffrées de bout en bout sont chiffrées sur votre appareil avant l’envoi, de
            sorte que notre stockage ne les détient jamais que sous forme de données illisibles. Les sauvegardes de
            notre base de données sont chiffrées.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">6. Conservation</h2>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>
              <strong className="text-vox-text-primary">Les pièces jointes des messages</strong> sont supprimées
              3&nbsp;jours après le message avec lequel elles ont été envoyées, par un nettoyage quotidien. Le message
              conserve le nom, la taille et le type du fichier, affiché comme fichier expiré&nbsp;; pour une pièce
              jointe chiffrée de bout en bout, ces informations se trouvent dans le message chiffré, et nos serveurs
              n’en conservent que la taille
            </li>
            <li>
              <strong className="text-vox-text-primary">Les données de connexion</strong> (adresses IP) sont
              supprimées après 180&nbsp;jours sans activité depuis cette adresse, à deux exceptions près&nbsp;: une adresse
              IP placée sur notre liste de blocage (par exemple lorsqu’un compte est banni de Voxium) y reste aussi
              longtemps que le blocage est maintenu&nbsp;; et nos journaux serveur, qui enregistrent l’adresse IP de
              chaque requête, font l’objet d’une rotation automatique et ne sont conservés que pendant une courte
              période
            </li>
            <li><strong className="text-vox-text-primary">Les comptes dont l’adresse e-mail n’est jamais vérifiée</strong> sont supprimés 7&nbsp;jours après l’inscription</li>
            <li>
              <strong className="text-vox-text-primary">Les demandes d’adhésion</strong> à un espace sont supprimées
              30&nbsp;jours après leur envoi si personne n’a statué sur elles&nbsp;; une demande refusée est conservée 7&nbsp;jours,
              afin que le même espace ne soit pas sollicité de nouveau tout de suite, puis supprimée
            </li>
            <li><strong className="text-vox-text-primary">Les membres retirés d’un espace</strong> y sont enregistrés comme bannis jusqu’à ce que l’un de ses modérateurs lève ce bannissement</li>
            <li><strong className="text-vox-text-primary">Les éléments de clé de chiffrement non remis</strong> sont supprimés après 30&nbsp;jours</li>
            <li>
              <strong className="text-vox-text-primary">Les conversations de support et les signalements</strong>{' '}
              n’expirent pas automatiquement&nbsp;: ils sont conservés pour le support et la modération, et sont
              supprimés avec le compte qui les a ouverts ou effectués, ou que concerne un signalement
            </li>
            <li>
              <strong className="text-vox-text-primary">Les webhooks entrants</strong> conservent leur nom, le salon
              dans lequel ils publient, qui les a créés, qui a renouvelé leur URL en dernier et quand, et la date de
              leur dernière utilisation&nbsp;; le corps d’une requête reçue par un webhook n’est pas conservé au-delà
              du message qu’elle a produit
            </li>
            <li>
              <strong className="text-vox-text-primary">Tout le reste</strong> est conservé tant que votre compte
              existe. La suppression de votre compte (Paramètres → Sécurité) supprime avec lui votre profil, vos
              messages et vos réactions, vos conversations privées (y compris les messages que l’autre participant y a
              envoyés), les clés et les sauvegardes de clés de vos appareils, vos données de connexion, vos
              conversations de support et les traces de votre consentement
            </li>
            <li>
              <strong className="text-vox-text-primary">Après la suppression de votre compte</strong>, certaines
              données subsistent&nbsp;: les traces des actions de modération et d’administration, qui ne sont plus
              liées à votre compte (une entrée peut encore contenir l’identifiant ou le nom d’utilisateur qu’elle a
              enregistré)&nbsp;; les webhooks que vous avez créés dans un espace, qui ne vous sont plus liés&nbsp;;
              les adresses IP figurant sur notre liste de blocage, jusqu’à la levée du blocage&nbsp;; les fichiers que
              vous avez envoyés, jusqu’à ce qu’un nettoyage quotidien les supprime, une fois que plus rien n’y fait
              référence et qu’ils datent d’au moins 7&nbsp;jours&nbsp;; et nos journaux serveur et nos sauvegardes
              chiffrées, jusqu’à leur remplacement au terme d’une durée limitée
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">7. Bases légales</h2>
          <p className="mb-3">En vertu du RGPD, nous traitons vos données sur les bases suivantes&nbsp;:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li><strong className="text-vox-text-primary">Exécution d’un contrat</strong> — votre compte, votre profil, vos messages, votre présence et vos appels&nbsp;: le Service que vous avez demandé</li>
            <li><strong className="text-vox-text-primary">Intérêt légitime</strong> — les données de connexion utilisées pour assurer la sécurité du Service et prévenir les abus, et comptabilisées par pays dans nos propres statistiques&nbsp;; les données de support et de modération</li>
            <li><strong className="text-vox-text-primary">Consentement</strong> — enregistré lorsque vous acceptez les Conditions d’utilisation et la présente Politique de confidentialité lors de votre inscription, ou ultérieurement depuis un compte existant</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">8. Tiers</h2>
          <p className="mb-3">
            Nous ne vendons ni ne partageons vos données à caractère personnel à des fins de marketing ou de
            publicité. Les prestataires qui hébergent nos serveurs et notre stockage ne traitent les données que dans
            la mesure nécessaire au fonctionnement du Service. Deux autres parties interviennent&nbsp;:
          </p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>
              <strong className="text-vox-text-primary">E-mail.</strong> Les e-mails liés au compte (vérification de
              l’adresse et réinitialisation du mot de passe) sont envoyés par l’intermédiaire d’un prestataire d’envoi
              d’e-mails, qui reçoit votre adresse e-mail et le message
            </li>
            <li>
              <strong className="text-vox-text-primary">Mises à jour de l’application.</strong> À son démarrage,
              l’application de bureau demande à GitHub, où nos versions sont publiées, si une version plus récente
              existe, et la télécharge depuis GitHub si vous choisissez de l’installer. GitHub voit votre adresse IP
              et cette requête
            </li>
          </ul>
          <p className="mt-3">
            Nous n’utilisons aucun service tiers de mesure d’audience, de pistage, de STUN/TURN ou de diffusion de
            contenu. Si vous auto-hébergez Voxium, vos données restent entièrement sous votre contrôle.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">9. Cookies et stockage local</h2>
          <p>
            Voxium n’utilise aucun cookie de pistage et aucun outil de mesure d’audience. Pour que votre session
            reste ouverte, l’application de bureau la stocke dans le gestionnaire d’identifiants de votre système
            d’exploitation lorsque vous choisissez «&nbsp;Se souvenir de moi&nbsp;», et sinon uniquement en mémoire
            jusqu’à la fermeture de l’application&nbsp;; dans un navigateur web, la session est conservée dans le
            stockage de ce navigateur. L’application conserve également vos préférences (réglages audio, micro
            ou son coupé, état de l’interface) et, sur votre appareil uniquement, les clés et le cache
            local des messages de vos conversations chiffrées de bout en bout. La Politique de cookies détaille
            chaque élément, l’endroit où il est conservé et pour combien de temps.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">10. Vos droits</h2>
          <p className="mb-3">Vous avez le droit de&nbsp;:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>Accéder aux données à caractère personnel que nous détenons à votre sujet&nbsp;: la plupart sont affichées dans l’application elle-même, et vous pouvez nous en demander une copie complète en écrivant à l’adresse ci-dessous</li>
            <li>Recevoir dans un format portable les données que vous nous avez fournies&nbsp;: l’application ne propose pas encore de téléchargement, vous pouvez donc nous en faire la demande en écrivant à l’adresse ci-dessous</li>
            <li>Rectifier des informations inexactes&nbsp;: votre nom d’affichage, votre bio et votre avatar peuvent être modifiés dans l’application, de même que vos pseudos d’espace lorsque l’espace le permet&nbsp;; pour corriger votre nom d’utilisateur ou votre adresse e-mail, contactez-nous</li>
            <li>Supprimer vous-même votre compte et les données associées, depuis Paramètres → Sécurité. Vous confirmez avec votre mot de passe, et avec votre code d’authentification à deux facteurs s’il est activé&nbsp;; si vous possédez encore des espaces, transférez-les ou supprimez-les d’abord</li>
            <li>Vous opposer au traitement fondé sur notre intérêt légitime, et retirer votre consentement — retirer votre consentement à la présente politique implique de fermer votre compte, puisque le Service ne peut pas fonctionner sans les données décrites ici</li>
            <li>
              Introduire une réclamation auprès de votre autorité de contrôle — en France, la CNIL (
              <a href="https://www.cnil.fr/fr/plaintes" target="_blank" rel="noopener noreferrer" className="text-vox-accent-primary hover:underline">
                cnil.fr/fr/plaintes
              </a>
              )
            </li>
          </ul>
          <p className="mt-3">
            Voxium étant un logiciel à code source disponible, vous pouvez également vérifier exactement comment vos
            données sont traitées en consultant son code source.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">11. Modifications de la présente politique</h2>
          <p className="mb-3">
            Nous pouvons réviser la présente Politique de confidentialité. Pour une modification substantielle, nous
            vous en informons dans l’application au moins {LEGAL_OPERATOR.changeNoticeDays}&nbsp;jours avant son
            entrée en vigueur&nbsp;; une modification mineure, ou sans effet défavorable pour vous, peut prendre effet
            dès sa publication. La date de «&nbsp;Dernière mise à
            jour&nbsp;» figurant en tête du document indique la version en vigueur. La poursuite de votre utilisation
            du Service après l’entrée en vigueur d’une modification vaut acceptation de celle-ci&nbsp;; si vous ne
            l’acceptez pas, cessez d’utiliser le Service et supprimez votre compte (voir «&nbsp;Vos droits&nbsp;»
            ci-dessus). Lorsqu’une modification porte sur un traitement fondé sur votre consentement, nous vous
            demandons à nouveau votre consentement au lieu de nous fonder sur la poursuite de votre utilisation.
          </p>
          <p>
            La présente politique est disponible en anglais et en français. La version anglaise est la version de
            référence et prévaut en cas de divergence, sauf lorsque le droit impératif de votre pays de résidence en
            dispose autrement.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">12. Contact</h2>
          <p className="mb-3">
            {publisher ? (
              <>Le responsable du traitement est l’éditeur de Voxium, {publisher.name}, {publisher.address}.</>
            ) : (
              <>
                Le responsable du traitement est l’éditeur de Voxium, qui exerce son activité depuis la{' '}
                {LEGAL_OPERATOR.country}&nbsp;; ses mentions légales sont disponibles sur demande à l’adresse{' '}
                <MailLink address={LEGAL_OPERATOR.contactEmail} />.
              </>
            )}
          </p>
          <p>
            Pour toute question concernant la présente Politique de confidentialité ou pour exercer vos droits sur vos
            données, écrivez à notre contact pour les questions de confidentialité à l’adresse{' '}
            <MailLink address={LEGAL_OPERATOR.privacyEmail} />.
            Pour toute demande d’ordre général, écrivez-nous à <MailLink address={LEGAL_OPERATOR.contactEmail} />.
          </p>
        </section>
      </div>
    </>
  );
}
