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
  creerLinkTokenRepairAction,
  demarrerConnexionAction,
  finaliserConnexionDropinAction,
  resynchroniserConnexionApresReparationAction,
  synchroniserConnexionsAction,
  type EtatDemarrage,
  type EtatFinalisation,
} from "@/app/(workspace)/banques/actions";
import { IconeSynchro } from "@/components/ui/icons/icone-synchro";
import {
  ROUTE_DASHBOARD,
  WidgetFeedback,
  type ConnexionAReparer,
  type ConnexionAReconnecter,
} from "./widget-feedback";

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

/** Repli si la création du LinkToken REPAIR échoue sans message serveur exploitable. */
const MESSAGE_REPAIR_ECHEC =
  "La reconnexion n’a pas pu démarrer. Réessayez dans un instant.";

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
  // Connexions à RÉPARER (signal serveur). Les boutons « Reconnecter » s'affichent
  // tant qu'une connexion y figure ; on la retire quand sa réparation a abouti.
  const [reparation, setReparation] = useState<ConnexionAReparer[]>([]);
  // Connexions à RECONNECTER (signal serveur `aReconnecter` : 403 désalignement). Pas
  // de REPAIR possible (aucun jobId) → l'invite pointe vers « Connecter une banque ».
  const [aReconnecter, setAReconnecter] = useState<ConnexionAReconnecter[]>([]);
  // Réparation EN COURS : token REPAIR obtenu + connexion ciblée → monte le launcher.
  // `null` = aucune réparation ouverte. Mutuellement exclusif avec l'onboarding.
  const [repair, setRepair] = useState<{ connectionId: string; token: string } | null>(
    null,
  );
  // `true` entre le clic « Reconnecter » et l'obtention du token (anti-double-clic).
  const [repairEnCours, setRepairEnCours] = useState(false);
  // Onboarding et réparation partagent l'UNIQUE point de montage du launcher (on ne
  // peut pas ouvrir deux widgets) : l'onboarding ne monte pas si une réparation est ouverte.
  const tokenActif = !ferme && !repair ? demarrage.linkToken : null;

  function finaliser(publicTokens: string[]) {
    // Flux NOMINAL : à la fin du parcours (onSuccess), la finalisation serveur
    // échange les publicToken (jamais loggés ici) puis découvre les comptes.
    setFerme(true);
    startFinalisation(async () => {
      const r: EtatFinalisationUI =
        await finaliserConnexionDropinAction(publicTokens);
      setFinalisation(r);
      setReparation(r.reparation ?? []);
      setAReconnecter(r.aReconnecter ?? []);
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
      // Le re-sync peut signaler des connexions à réparer (OTP redemandé) → on les
      // expose pour faire apparaître le(s) bouton(s) « Reconnecter ».
      setReparation(r.reparation ?? []);
      // …ou des connexions dont l'accès est désaligné (403) → invite à reconnecter.
      setAReconnecter(r.aReconnecter ?? []);
    });
  }

  function lancerReparation(cx: ConnexionAReparer) {
    // Clic « Reconnecter » : on demande un LinkToken REPAIR (Mode REPAIR, verrouillé
    // sur la banque), puis on monte le MÊME launcher avec ce token. Le widget gère
    // l'OTP en interne. On NE redirige pas et on NE touche pas l'onboarding.
    setRepairEnCours(true);
    startFinalisation(async () => {
      const r = await creerLinkTokenRepairAction(
        cx.connectionId,
        cx.jobId,
        redirectOrigin,
      );
      setRepairEnCours(false);
      if (r.erreur !== null || !r.linkToken) {
        // Échec de création du token : message d'erreur, l'état réparation RESTE
        // (le bouton reste cliquable pour réessayer). Pas de launcher monté.
        setFinalisation({ erreur: r.erreur ?? MESSAGE_REPAIR_ECHEC, succes: null });
        return;
      }
      setFinalisation(ETAT_FINALISATION_VIDE);
      setRepair({ connectionId: cx.connectionId, token: r.linkToken });
    });
  }

  function apresReparation(connectionId: string) {
    // onSuccess du widget REPAIR (l'OTP a été saisi dans le widget) : on démonte le
    // launcher puis on RE-LIT cette connexion (mêmes comptes → ingestion existante).
    setRepair(null);
    startFinalisation(async () => {
      const r = await resynchroniserConnexionApresReparationAction(connectionId);
      setFinalisation(r);
      // La connexion réparée sort de la liste ; si le serveur re-signale une réparation
      // (rare : OTP redemandé), `r.reparation` la remet avec le NOUVEAU jobId.
      setReparation((prev) =>
        prev
          .filter((c) => c.connectionId !== connectionId)
          .concat(r.reparation ?? []),
      );
    });
  }

  function fermerReparation() {
    // Widget REPAIR fermé/quitté/erreur SANS finir : on démonte le launcher, mais la
    // connexion RESTE dans `reparation` (le bouton « Reconnecter » reste cliquable).
    setRepair(null);
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
      {/* UNIQUE point de montage du launcher (ssr:false) : RÉPARATION prioritaire, sinon
          onboarding. On ne peut pas ouvrir deux widgets — `tokenActif` est déjà null si
          une réparation est ouverte. En REPAIR, le widget gère l'OTP en interne ; son
          `onSuccess` ne sert pas à finaliser un publicToken (le job MFA existant se
          termine) → on ignore les tokens et on RE-LIT la connexion par son id. */}
      {repair ? (
        <OmniFiLinkLauncher
          token={repair.token}
          onConnexions={() => apresReparation(repair.connectionId)}
          onClose={fermerReparation}
        />
      ) : (
        tokenActif && (
          <OmniFiLinkLauncher
            token={tokenActif}
            onConnexions={finaliser}
            onClose={() => setFerme(true)}
          />
        )
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
            disabled={
              demarrageEnCours ||
              Boolean(tokenActif) ||
              redirection ||
              Boolean(repair) ||
              repairEnCours
            }
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
            Omni-FI et rattache/met à jour les comptes. Action PERMANENTE de
            rafraîchissement des données (et repli si le widget n'a pas finalisé).
            Lien d'action (§2.3), de rang secondaire à l'action principale ; le
            tooltip précise ce qu'elle fait. Idempotent côté serveur. */}
        <button
          type="button"
          onClick={synchroniser}
          disabled={Boolean(tokenActif) || redirection || Boolean(repair) || repairEnCours}
          title="Relit vos connexions chez votre banque et met à jour vos comptes (y compris ceux qui n’apparaîtraient pas encore)."
          className="inline-flex h-10 items-center gap-1.5 rounded-control px-2 text-sm
            font-semibold text-primary transition-colors hover:text-primary-600
            hover:underline focus:outline-none focus-visible:ring-2
            focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-48"
        >
          <IconeSynchro />
          Synchroniser mes comptes
        </button>
      </div>

      <WidgetFeedback
        erreurDemarrage={demarrage.erreur}
        erreurFinalisation={finalisation.erreur}
        succes={finalisation.succes}
        redirection={redirection}
        reparation={reparation}
        onReconnecter={lancerReparation}
        reparationEnCours={repairEnCours || Boolean(repair)}
        aReconnecter={aReconnecter}
      />
    </div>
  );
}
