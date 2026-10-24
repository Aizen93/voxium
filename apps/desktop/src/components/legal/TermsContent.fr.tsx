/**
 * Les Conditions d'utilisation en français: the translation of
 * TermsContent.en.tsx, section by section. The English file's rules apply
 * here unchanged, and __tests__/legal/legalFacts.test.ts checks this file
 * exactly like the English one, plus the same count of sections and list items
 * as the English and the French spacing (a no-break space, &nbsp;, before
 * : ; ? ! and inside « »).
 *
 * The French says nothing the English does not: a change to the English is
 * made here in the same commit.
 */
export function TermsContentFr() {
  return (
    <>
      <h1 className="text-3xl sm:text-4xl font-bold mb-2">Conditions d'utilisation</h1>
      <p className="text-sm text-vox-text-muted mb-10">Dernière mise à jour&nbsp;: 24 octobre 2026</p>

      <div className="space-y-8 text-vox-text-secondary leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">1. Acceptation des conditions</h2>
          <p>
            En accédant à Voxium («&nbsp;le Service&nbsp;») ou en l'utilisant, vous vous engagez à respecter les
            présentes Conditions d'utilisation. Si vous n'acceptez pas ces conditions, vous ne pouvez pas utiliser le
            Service. Nous nous réservons le droit de modifier ces conditions à tout moment, et la poursuite de
            l'utilisation du Service vaut acceptation de toute modification.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">2. Comptes</h2>
          <p>
            Vous êtes responsable de la confidentialité de vos identifiants de compte et de toutes les activités
            effectuées depuis votre compte. Vous devez fournir des informations exactes lors de la création d'un
            compte. Vous pouvez modifier à tout moment votre nom d'affichage, votre bio et votre avatar dans
            l'application&nbsp;; votre nom d'utilisateur et votre adresse e-mail ne peuvent pas être modifiés depuis
            l'application, contactez-nous donc si l'un ou l'autre doit être corrigé. Vous devez avoir au moins
            13&nbsp;ans pour utiliser le Service, et en créant un compte, vous confirmez que c'est le cas.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">3. Utilisation acceptable</h2>
          <p className="mb-3">Vous vous engagez à ne pas utiliser le Service pour&nbsp;:</p>
          <ul className="list-disc list-inside space-y-1.5 ml-2">
            <li>Enfreindre les lois ou réglementations applicables</li>
            <li>Harceler, injurier ou menacer d'autres utilisateurs</li>
            <li>Diffuser du spam, des logiciels malveillants ou tout autre contenu nuisible</li>
            <li>Tenter d'accéder sans autorisation au Service ou aux comptes d'autres utilisateurs</li>
            <li>Perturber ou entraver l'infrastructure du Service</li>
            <li>Usurper l'identité d'une personne ou d'une entité</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">4. Contenu</h2>
          <p>
            Vous conservez la propriété du contenu que vous publiez par l'intermédiaire du Service. En publiant du
            contenu, vous accordez à Voxium une licence non exclusive et mondiale pour stocker et transmettre ce
            contenu dans la mesure nécessaire au fonctionnement du Service. Vous êtes l'unique responsable du contenu
            que vous publiez et devez vous assurer qu'il ne porte pas atteinte aux droits d'autrui.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">5. Résiliation</h2>
          <p>
            Nous pouvons suspendre ou résilier votre compte à tout moment si vous enfreignez ces conditions ou si vous
            adoptez un comportement que nous jugeons préjudiciable au Service ou aux autres utilisateurs. Vous pouvez
            supprimer vous-même votre compte depuis Paramètres → Sécurité&nbsp;: vous confirmez avec votre mot de
            passe, et avec votre code d'authentification à deux facteurs s'il est activé, et si vous possédez encore
            des serveurs, transférez-les ou supprimez-les d'abord. En cas de résiliation, votre droit d'utiliser le
            Service prend fin immédiatement.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">6. Exclusion de garanties</h2>
          <p>
            Le Service est fourni «&nbsp;en l'état&nbsp;» et «&nbsp;selon sa disponibilité&nbsp;», sans garantie
            d'aucune sorte, expresse ou implicite. Nous ne garantissons pas que le Service sera ininterrompu, sécurisé
            ou exempt d'erreurs. Dans toute la mesure permise par la loi, Voxium décline toute responsabilité pour tout
            dommage résultant de votre utilisation du Service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">7. Modifications des présentes conditions</h2>
          <p>
            Nous pouvons réviser ces conditions de temps à autre. Dans ce cas, nous mettrons à jour la date de
            «&nbsp;Dernière mise à jour&nbsp;» en haut de cette page. Nous vous encourageons à consulter régulièrement
            ces conditions. La poursuite de votre utilisation du Service après la publication des modifications vaut
            acceptation des conditions révisées.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-vox-text-primary mb-3">8. Contact</h2>
          <p>
            Pour toute question concernant les présentes Conditions d'utilisation, contactez-nous à l'adresse{' '}
            <a href="mailto:contact@voxium.app" className="text-vox-accent-primary hover:underline">
              contact@voxium.app
            </a>.
          </p>
        </section>
      </div>
    </>
  );
}
