"use client";

/**
 * Conteneur du WIDGET NATIF Omni-FI (PR-W4, RÉ-ALIGNÉ 2026-06-16). On ne pilote
 * plus la machine MFA maison : on consomme le drop-in officiel `@omnifi/react`,
 * qui gère lui-même credentials / OTP / sélection de comptes.
 *
 * ⚠️ Contrat ré-aligné sur le CODE SOURCE (github.com/omni-fi-app/omni-fi-react-link),
 * la doc Fern étant fausse. Différences clés :
 *   - L'API est un HOOK `useOmniFILink({ token, onSuccess, ... })`, PAS un composant.
 *   - Entrée = `token` (le LinkToken serveur).
 *   - `onSuccess` reçoit `{ connections: [...] }` — potentiellement PLUSIEURS
 *     connexions ; chacune porte `publicToken` (+ connectionId, institutionId…).
 *   - Le widget charge un script CDN → on attend `isReady` avant `open()`.
 *
 * ⚠️ MODULE FANTÔME (correctif QA 2026-06-16) : `@omnifi/react` vit sur un registre
 * npm PRIVÉ (poste de démo), absent de node_modules ici. Un `import` STATIQUE du
 * hook `useOmniFILink` faisait crasher tout le build (500), démo comprise. Comme on
 * NE PEUT PAS lazy-loader un hook (il s'appelle au top-level), on isole TOUT l'usage
 * du hook dans un sous-composant `OmniFiLinkLauncher` chargé via `next/dynamic`
 * (`ssr:false`). Ce conteneur n'importe donc plus `@omnifi/react` : le module n'est
 * résolu qu'au RUNTIME, et seulement quand un LinkToken actif monte le launcher.
 * Un garde-fou (`WidgetErrorBoundary`) capte l'échec de chargement et affiche une
 * UI propre au lieu de crasher la page.
 *
 * Cycle :
 *   1. clic « Connecter une banque » → `demarrerConnexionAction` (serveur, ApiKey)
 *      retourne un LinkToken usage-unique.
 *   2. LinkToken présent → on monte le launcher lazy ; il injecte le token dans
 *      `useOmniFILink` et `open()` dès `isReady`.
 *   3. onSuccess → on extrait les `publicToken` de chaque connexion et on appelle
 *      `finaliserConnexionDropinAction(publicTokens)`. onExit/onError → réarme.
 *
 * Sécurité : ni LinkToken ni PublicToken ne sont loggés/persistés côté client
 * (règle 8) ; ils transitent vers les Server Actions. Le gating MANAGER/ADMIN est
 * porté par le serveur ; ici on n'affiche le bouton que si `peutConnecter` (UX).
 */
import {
  Component,
  type ReactNode,
  useActionState,
  useState,
  useTransition,
} from "react";

import dynamic from "next/dynamic";

import {
  demarrerConnexionAction,
  finaliserConnexionDropinAction,
  type EtatDemarrage,
  type EtatFinalisation,
} from "@/app/(workspace)/banques/actions";

const ETAT_DEMARRAGE: EtatDemarrage = { erreur: null, linkToken: null };

/**
 * Launcher lazy : c'est lui (et lui seul) qui importe `@omnifi/react`. Chargé via
 * `next/dynamic` → le module fantôme n'est résolu qu'au montage runtime, jamais au
 * build. `ssr:false` : widget purement client.
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

/**
 * Garde-fou : capture l'échec de chargement/rendu du launcher (module fantôme
 * absent en dev → « Cannot find module '@omnifi/react' ») et affiche une UI propre
 * au lieu de laisser crasher la page. Class component : seul mécanisme React pour
 * intercepter une erreur de rendu d'un enfant.
 */
class WidgetErrorBoundary extends Component<
  { children: ReactNode },
  { enErreur: boolean }
> {
  state = { enErreur: false };

  static getDerivedStateFromError() {
    return { enErreur: true };
  }

  render() {
    if (this.state.enErreur) {
      return (
        <div
          role="alert"
          className="rounded-control bg-warning-bg px-4 py-3 text-sm text-warning"
        >
          Le module de connexion bancaire n’est pas disponible dans cet
          environnement. Réessayez depuis l’environnement de démonstration.
        </div>
      );
    }
    return this.props.children;
  }
}

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
  const [finalisation, setFinalisation] = useState<EtatFinalisation>({
    erreur: null,
    succes: null,
  });
  const [, startFinalisation] = useTransition();
  // Le LinkToken courant monte le launcher. `ferme` réarme après sortie/succès.
  const [ferme, setFerme] = useState(false);
  const tokenActif = !ferme ? demarrage.linkToken : null;

  function finaliser(publicTokens: string[]) {
    // publicToken jamais loggés ici ; la finalisation serveur les échange puis
    // découvre les comptes via GET /accounts.
    setFerme(true);
    startFinalisation(async () => {
      const r = await finaliserConnexionDropinAction(publicTokens);
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
      {/* Launcher lazy monté seulement quand un LinkToken est actif → le module
          fantôme n'est sollicité qu'à ce moment, jamais au démarrage de l'appli. */}
      {tokenActif && (
        <WidgetErrorBoundary>
          <OmniFiLinkLauncher
            token={tokenActif}
            onConnexions={finaliser}
            onClose={() => setFerme(true)}
          />
        </WidgetErrorBoundary>
      )}

      <form
        action={(fd) => {
          // Réarme : un nouveau démarrage doit ré-ouvrir le widget même après une
          // fermeture précédente (le LinkToken renvoyé sera de nouveau « actif »).
          setFerme(false);
          setFinalisation({ erreur: null, succes: null });
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
          disabled={demarrageEnCours || Boolean(tokenActif)}
          className="inline-flex h-10 items-center gap-2 rounded-control bg-primary
            px-4 text-sm font-semibold text-text-onink transition-colors
            hover:bg-primary-600 focus:outline-none focus-visible:ring-2
            focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-48"
        >
          <span aria-hidden>+</span>
          {demarrageEnCours || tokenActif ? "Ouverture…" : "Connecter une banque"}
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
