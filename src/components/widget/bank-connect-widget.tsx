"use client";

/**
 * Conteneur du WIDGET NATIF Omni-FI (PR-W4). On ne pilote plus la machine MFA
 * maison : on consomme le drop-in officiel `@omni-fi/react-link` (vendoré, cf.
 * SECURITY_VENDORING.md), qui gère lui-même credentials / OTP / sélection de comptes.
 *
 * Contrat (types réels du package) :
 *   - L'API est un HOOK `useOmniFILink({ token, onSuccess, ... })`, PAS un composant.
 *   - Entrée = `token` (le LinkToken serveur).
 *   - `onSuccess` reçoit `{ connections: [...] }` — potentiellement PLUSIEURS
 *     connexions ; chacune porte `publicToken` (+ connectionId, institutionId…).
 *   - Le widget charge un script CDN → on attend `isReady` avant `open()`.
 *
 * Le hook touche `window.OmniFI` / charge un script CDN → il ne peut PAS s'exécuter
 * en SSR. On isole son usage dans `OmniFiLinkLauncher`, chargé via `next/dynamic`
 * (`ssr:false`) et monté seulement quand un LinkToken est actif.
 *
 * Cycle :
 *   1. clic « Connecter une banque » → `demarrerConnexionAction` (serveur, ApiKey)
 *      retourne un LinkToken usage-unique.
 *   2. LinkToken présent → on monte le launcher ; il injecte le token dans
 *      `useOmniFILink` et `open()` dès `isReady`.
 *   3. onSuccess → on extrait les `publicToken` de chaque connexion et on appelle
 *      `finaliserConnexionDropinAction(publicTokens)`. onExit/onError → réarme.
 *   4. Finalisation COMPLÈTE (toutes les banques rattachées) → on emmène
 *      l'utilisateur sur le Dashboard (`/`), où ses comptes fraîchement connectés
 *      apparaissent. Finalisation PARTIELLE → on RESTE ici pour montrer ce qui a
 *      échoué (ne pas masquer un échec derrière une navigation).
 *
 * Sécurité : ni LinkToken ni PublicToken ne sont loggés/persistés côté client
 * (règle 8) ; ils transitent vers les Server Actions. Le gating MANAGER/ADMIN est
 * porté par le serveur ; ici on n'affiche le bouton que si `peutConnecter` (UX).
 */
import { useActionState, useState, useTransition } from "react";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";

import {
  demarrerConnexionAction,
  finaliserConnexionDropinAction,
  synchroniserConnexionsAction,
  type EtatDemarrage,
  type EtatFinalisation,
} from "@/app/(workspace)/banques/actions";
import { ROUTE_DASHBOARD, WidgetFeedback } from "./widget-feedback";

const ETAT_DEMARRAGE: EtatDemarrage = { erreur: null, linkToken: null };

/**
 * Vue UI de l'état de finalisation. Étend le contrat Backend (`EtatFinalisation`)
 * d'un signal OPTIONNEL `complet` : `true` ssi TOUTES les connexions ont été
 * finalisées (aucun échec). Il pilote la redirection vers le Dashboard.
 *
 * Contract-first : tant que le Backend n'expose pas ce champ, il vaut `undefined`
 * → la garde « rediriger SEULEMENT si `complet === true` » échoue côté sûr (on
 * reste sur place et on affiche le succès, jamais de redirection au pif qui
 * masquerait un succès partiel). Liste de courses Backend : TODOS « WIDGET-RD1 ».
 */
type EtatFinalisationUI = EtatFinalisation & { complet?: boolean };

const ETAT_FINALISATION_VIDE: EtatFinalisationUI = { erreur: null, succes: null };

/**
 * Launcher chargé via `next/dynamic` (`ssr:false`) : le hook `useOmniFILink` touche
 * `window` / un script CDN et ne doit pas s'exécuter côté serveur.
 */
const OmniFiLinkLauncher = dynamic(
  () => import("./omnifi-link-launcher").then((m) => m.OmniFiLinkLauncher),
  {
    ssr: false,
    loading: () => (
      <p className="text-sm text-text-muted">Ouverture du module de connexion…</p>
    ),
  },
);

export function BankConnectWidget({
  peutConnecter,
}: {
  /** Rôle autorisé (MANAGER/ADMIN) — UX seulement ; la barrière réelle est serveur. */
  peutConnecter: boolean;
}) {
  const router = useRouter();
  const [demarrage, demarrer, demarrageEnCours] = useActionState(
    demarrerConnexionAction,
    ETAT_DEMARRAGE,
  );
  const [finalisation, setFinalisation] =
    useState<EtatFinalisationUI>(ETAT_FINALISATION_VIDE);
  const [, startFinalisation] = useTransition();
  // Le LinkToken courant monte le launcher. `ferme` réarme après sortie/succès.
  const [ferme, setFerme] = useState(false);
  // Verrou anti-double-déclenchement : une fois la redirection lancée, on neutralise
  // l'UI (le launcher peut, en théorie, ré-émettre). `router.push` est async.
  const [redirection, setRedirection] = useState(false);
  const tokenActif = !ferme ? demarrage.linkToken : null;

  function finaliser(publicTokens: string[]) {
    // Flux NOMINAL : à la fin du parcours (onSuccess), la finalisation serveur
    // échange les publicToken (jamais loggés ici) puis découvre les comptes.
    setFerme(true);
    startFinalisation(async () => {
      const r: EtatFinalisationUI =
        await finaliserConnexionDropinAction(publicTokens);
      setFinalisation(r);
      // Succès COMPLET → on emmène l'utilisateur voir ses comptes sur le Dashboard.
      // Garde stricte : SEULEMENT si le serveur confirme `complet === true`. En
      // succès partiel (ou flag pas encore exposé) on reste ici pour afficher
      // l'état — jamais de redirection qui masquerait un échec (cf. type UI).
      if (r.erreur === null && r.complet === true) {
        setRedirection(true);
        router.push(ROUTE_DASHBOARD);
      }
    });
  }

  function synchroniser() {
    // Re-synchronisation MANUELLE : relit l'état réel côté Omni-FI (GET /connections)
    // et rattache les comptes. Utile pour rafraîchir des connexions existantes, et
    // comme repli si le widget n'a pas finalisé (cf. OMNIFI_API_FEEDBACK.md §5).
    // Idempotent côté serveur (pas de doublon). Pas de redirection auto ici : c'est
    // une action de rattrapage déclenchée par l'utilisateur, il reste maître.
    startFinalisation(async () => {
      const r = await synchroniserConnexionsAction();
      setFinalisation(r);
    });
  }

  if (!peutConnecter) {
    return (
      <p className="text-sm text-text-muted">
        Seuls les managers et administrateurs peuvent connecter une banque.
      </p>
    );
  }

  // RedirectOrigin = origine https sans path (contrat link-token), lue côté
  // navigateur. En dev (http://localhost) l'action la rejettera : le widget natif
  // exige https — c'est attendu, la démo tourne sur un domaine https.
  const redirectOrigin =
    typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="flex flex-col gap-3">
      {/* Launcher monté seulement quand un LinkToken est actif (ssr:false). */}
      {tokenActif && (
        <OmniFiLinkLauncher
          token={tokenActif}
          onConnexions={finaliser}
          onClose={() => setFerme(true)}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <form
          action={(fd) => {
            // Réarme : un nouveau démarrage doit ré-ouvrir le widget même après une
            // fermeture précédente (le LinkToken renvoyé sera de nouveau « actif »).
            setFerme(false);
            setFinalisation(ETAT_FINALISATION_VIDE);
            demarrer(fd);
          }}
        >
          <input
            type="hidden"
            name="redirectOrigin"
            value={redirectOrigin}
            readOnly
          />
          <button
            type="submit"
            disabled={demarrageEnCours || Boolean(tokenActif) || redirection}
            className="inline-flex h-10 items-center gap-2 rounded-control bg-primary
              px-4 text-sm font-semibold text-text-onink transition-colors
              hover:bg-primary-600 focus:outline-none focus-visible:ring-2
              focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-48"
          >
            <span aria-hidden>+</span>
            {demarrageEnCours || tokenActif ? "Ouverture…" : "Connecter une banque"}
          </button>
        </form>

        {/* Re-synchronisation manuelle (GET /connections) — relit l'état réel chez
            Omni-FI et rattache les comptes. Sert surtout de RATTRAPAGE quand une
            banque connectée n'apparaît pas (widget non finalisé). Présenté comme un
            LIEN D'ACTION (§2.3), pas un bouton de même rang que l'action principale :
            son libellé dit QUAND s'en servir. */}
        <button
          type="button"
          onClick={synchroniser}
          disabled={Boolean(tokenActif) || redirection}
          title="Relit vos connexions chez votre banque et rattache les comptes manquants."
          className="inline-flex h-10 items-center gap-1 rounded-control px-2 text-sm
            font-semibold text-primary transition-colors hover:text-primary-600
            hover:underline focus:outline-none focus-visible:ring-2
            focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-48"
        >
          Une banque n’apparaît pas ?
        </button>
      </div>

      <WidgetFeedback
        erreurDemarrage={demarrage.erreur}
        erreurFinalisation={finalisation.erreur}
        succes={finalisation.succes}
        redirection={redirection}
      />
    </div>
  );
}
