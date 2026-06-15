"use client";

/**
 * Conteneur du WIDGET NATIF Omni-FI (PR-W4). Remplace le flux MFA custom : on ne
 * pilote plus la machine à états maison — on monte le drop-in `<OmniFiWidget/>`
 * (package privé `@omnifi/react`) qui gère lui-même credentials / OTP / sélection
 * de comptes.
 *
 * Cycle :
 *   1. clic « Connecter une banque » → `demarrerConnexionAction` (serveur, ApiKey)
 *      retourne un LinkToken usage-unique.
 *   2. LinkToken présent → on monte `<OmniFiWidget linkToken=… />`. Le widget natif
 *      prend la main (UI bancaire native).
 *   3. onSuccess → `finaliserConnexionAction` échange les tokens côté serveur et
 *      rattache la connexion ; onExit/onError → on réarme le bouton.
 *
 * Sécurité : le LinkToken et les tokens de session ne sont NI loggés NI persistés
 * côté client (règle 8) ; ils transitent vers les Server Actions qui les relaient.
 * Le gating MANAGER/ADMIN est porté par le serveur (les actions refusent un VIEWER) ;
 * ici on n'affiche le bouton que si `peutConnecter` (UX), la barrière réelle est serveur.
 */
import { useActionState, useState } from "react";

import { OmniFiWidget, type OmniFiSuccess } from "@omnifi/react";

import {
  demarrerConnexionAction,
  finaliserConnexionAction,
  type EtatDemarrage,
  type EtatFinalisation,
} from "@/app/(workspace)/banques/actions";

const ETAT_DEMARRAGE: EtatDemarrage = { erreur: null, linkToken: null };
const ETAT_FINALISATION: EtatFinalisation = { erreur: null, succes: null };

export function BankConnectWidget({
  peutConnecter,
}: {
  /** Rôle autorisé (MANAGER/ADMIN) — UX seulement ; la barrière réelle est serveur. */
  peutConnecter: boolean;
}) {
  const [demarrage, demarrer, demarrageEnCours] = useActionState(
    demarrerConnexionAction,
    ETAT_DEMARRAGE,
  );
  const [finalisation, finaliser] = useActionState(
    finaliserConnexionAction,
    ETAT_FINALISATION,
  );
  // Le widget est monté tant que l'action a produit un LinkToken ET que
  // l'utilisateur ne l'a pas fermé. `ferme` réarme après sortie/succès sans
  // copier le token dans un état (pas de setState-in-effect — état DÉRIVÉ).
  const [ferme, setFerme] = useState(false);
  const tokenActif = !ferme ? demarrage.linkToken : null;

  function onSuccess(result: OmniFiSuccess) {
    // Échange serveur (publicToken + sessionToken + jobId). Jamais loggés ici.
    const fd = new FormData();
    fd.set("publicToken", result.publicToken);
    fd.set("sessionToken", result.sessionToken);
    fd.set("jobId", result.jobId);
    finaliser(fd);
    setFerme(true);
  }

  if (!peutConnecter) {
    return (
      <p className="text-sm text-text-muted">
        Seuls les managers et administrateurs peuvent connecter une banque.
      </p>
    );
  }

  // Widget natif monté : il occupe la surface, gère credentials/OTP/comptes.
  if (tokenActif) {
    return (
      <div className="rounded-card bg-surface-card p-6 shadow-card">
        <OmniFiWidget
          linkToken={tokenActif}
          onSuccess={onSuccess}
          onExit={() => setFerme(true)}
          onError={() => setFerme(true)}
        />
      </div>
    );
  }

  // État repos : bouton de démarrage + retours d'erreur/succès des actions.
  // RedirectOrigin = origine https sans path (contrat link-token), lue côté
  // navigateur. En dev (http://localhost) l'action la rejettera : le widget natif
  // exige https — c'est attendu, la démo tourne sur un domaine https.
  const redirectOrigin =
    typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="flex flex-col gap-3">
      <form
        action={(fd) => {
          // Réarme : un nouveau démarrage doit remonter le widget même après une
          // fermeture précédente (le LinkToken renvoyé sera de nouveau « actif »).
          setFerme(false);
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
          disabled={demarrageEnCours}
          className="inline-flex h-10 items-center gap-2 rounded-control bg-primary
            px-4 text-sm font-semibold text-text-onink transition-colors
            hover:bg-primary-600 focus:outline-none focus-visible:ring-2
            focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-48"
        >
          <span aria-hidden>+</span>
          {demarrageEnCours ? "Ouverture…" : "Connecter une banque"}
        </button>
      </form>

      {demarrage.erreur && (
        <p role="alert" className="text-sm text-danger">
          {demarrage.erreur}
        </p>
      )}
      {finalisation.erreur && (
        <p role="alert" className="text-sm text-danger">
          {finalisation.erreur}
        </p>
      )}
      {finalisation.succes && (
        <p className="text-sm text-success">{finalisation.succes}</p>
      )}
    </div>
  );
}
