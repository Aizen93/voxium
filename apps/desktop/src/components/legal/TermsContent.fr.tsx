import { MINIMUM_AGE } from '@voxium/shared';
import { LEGAL_OPERATOR, publisherOf } from './operator';
import { MailLink } from './MailLink';

/**
 * Les Conditions d'utilisation en français: the translation of
 * TermsContent.en.tsx, section by section, sentence by sentence (the English
 * is the reference version, section 1). The English file's rules apply here
 * unchanged, and __tests__/legal/legalFacts.test.ts checks this file exactly
 * like the English one, plus the same shape as the English (sections,
 * paragraphs, list items, emphasis, links) and French typography (a no-break
 * space, &nbsp;, before : ; ? ! and inside « », and the typographic apostrophe
 * ’ in the text).
 *
 * The French says nothing the English does not: a change to the English is
 * made here in the same commit.
 */
export function TermsContentFr() {
  const publisher = publisherOf(LEGAL_OPERATOR);
  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold mb-2">Conditions d’utilisation</h1>
      <p className="text-sm text-vox-text-muted mb-10">Dernière mise à jour&nbsp;: 25 octobre 2026</p>

      <div className="space-y-8 text-vox-text-secondary leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">1. Acceptation des conditions</h2>
          <p className="mb-3">
            {publisher ? (
              <>Voxium est édité et exploité par {publisher.name}, {publisher.address}.</>
            ) : (
              <>
                Voxium est édité et exploité depuis la {LEGAL_OPERATOR.country}. Les mentions légales de l’éditeur
                (identité et adresse postale) sont disponibles sur demande à l’adresse{' '}
                <MailLink address={LEGAL_OPERATOR.contactEmail} />.
              </>
            )}
          </p>
          <p>
            En accédant à Voxium («&nbsp;le Service&nbsp;») ou en l’utilisant, vous vous engagez à respecter les
            présentes Conditions d’utilisation. Si vous n’acceptez pas ces conditions, vous ne pouvez pas utiliser le
            Service. Nous pouvons modifier ces conditions selon les modalités décrites sous «&nbsp;Modifications des
            présentes conditions&nbsp;» ci-dessous. Les présentes conditions sont disponibles en anglais et en
            français. La version anglaise est la version de référence et prévaut en cas de divergence, sauf lorsque
            le droit impératif de votre pays de résidence en dispose autrement.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">2. Comptes</h2>
          <p>
            Vous êtes responsable de la confidentialité de vos identifiants de compte et de toutes les activités
            effectuées depuis votre compte. Vous devez fournir des informations exactes lors de la création d’un
            compte. Vous pouvez modifier à tout moment votre nom d’affichage, votre bio et votre avatar dans
            l’application&nbsp;; votre nom d’utilisateur et votre adresse e-mail ne peuvent pas être modifiés depuis
            l’application, contactez-nous donc si l’un ou l’autre doit être corrigé. Vous devez avoir au moins
            {' '}{MINIMUM_AGE}&nbsp;ans pour utiliser le Service, et en créant un compte, vous confirmez que c’est le cas.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">3. Utilisation acceptable</h2>
          <p className="mb-3">Vous vous engagez à ne pas utiliser le Service pour&nbsp;:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>Enfreindre les lois ou réglementations applicables</li>
            <li>Harceler, injurier ou menacer d’autres utilisateurs</li>
            <li>Diffuser du spam, des logiciels malveillants ou tout autre contenu nuisible</li>
            <li>Tenter d’accéder sans autorisation au Service ou aux comptes d’autres utilisateurs</li>
            <li>Perturber ou entraver l’infrastructure du Service</li>
            <li>Usurper l’identité d’une personne ou d’une entité</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">4. Contenu</h2>
          <p>
            Vous conservez la propriété du contenu que vous publiez par l’intermédiaire du Service. En publiant du
            contenu, vous accordez à Voxium une licence non exclusive et mondiale pour stocker et transmettre ce
            contenu dans la mesure nécessaire au fonctionnement du Service. Vous êtes l’unique responsable du contenu
            que vous publiez et devez vous assurer qu’il ne porte pas atteinte aux droits d’autrui.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">5. Résiliation</h2>
          <p>
            Nous pouvons suspendre ou résilier votre compte à tout moment si vous enfreignez ces conditions ou si vous
            adoptez un comportement que nous jugeons préjudiciable au Service ou aux autres utilisateurs. Vous pouvez
            supprimer vous-même votre compte depuis Paramètres → Sécurité&nbsp;: vous confirmez avec votre mot de
            passe, et avec votre code d’authentification à deux facteurs s’il est activé, et si vous possédez encore
            des espaces, transférez-les ou supprimez-les d’abord. En cas de résiliation, votre droit d’utiliser le
            Service prend fin immédiatement.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">6. Exclusion de garanties</h2>
          <p>
            Le Service est fourni «&nbsp;en l’état&nbsp;» et «&nbsp;selon sa disponibilité&nbsp;», sans garantie
            d’aucune sorte, expresse ou implicite. Nous ne garantissons pas que le Service sera ininterrompu, sécurisé
            ou exempt d’erreurs. Dans toute la mesure permise par la loi, Voxium décline toute responsabilité pour les
            dommages découlant de votre utilisation du Service. Certaines législations n’autorisent pas l’exclusion
            ou la limitation de certaines responsabilités&nbsp;; lorsque tel est le cas, ces exclusions ne
            s’appliquent que dans la mesure permise, et rien dans les présentes conditions n’affecte les droits dont
            vous disposez en tant que consommateur en vertu du droit impératif.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">7. Modifications des présentes conditions</h2>
          <p>
            Nous pouvons réviser ces conditions. Pour une modification substantielle, nous vous en informons dans
            l’application au moins {LEGAL_OPERATOR.changeNoticeDays}&nbsp;jours avant son entrée en vigueur&nbsp;; une
            modification mineure, ou sans effet défavorable pour vous, peut prendre effet dès sa publication. La date de «&nbsp;Dernière mise à jour&nbsp;» figurant en tête du
            document indique la version en vigueur. La poursuite de votre utilisation du Service après l’entrée en
            vigueur d’une modification vaut acceptation de celle-ci&nbsp;; si vous ne l’acceptez pas, cessez
            d’utiliser le Service et supprimez votre compte (voir «&nbsp;Résiliation&nbsp;» ci-dessus).
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">8. Droit applicable et juridiction compétente</h2>
          <p>
            Les présentes conditions sont régies par le droit français. Tout litige relatif au Service relève de la
            compétence des juridictions françaises, sauf si le droit impératif de protection des consommateurs de
            votre pays de résidence en dispose autrement.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">9. Contact</h2>
          <p>
            Pour toute question concernant les présentes Conditions d’utilisation, contactez-nous à l’adresse{' '}
            <MailLink address={LEGAL_OPERATOR.contactEmail} />.
          </p>
        </section>
      </div>
    </>
  );
}
