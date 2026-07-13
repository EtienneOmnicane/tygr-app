/**
 * Feedback présentationnel PUR du flux de connexion bancaire (extrait de
 * `bank-connect-widget.tsx`). Aucun fetch, aucun état interne, aucune Server
 * Action : on rend le message d'erreur / succès / redirection à partir de props.
 *
 * Le double usage est volontaire :
 *   - `BankConnectWidget` le monte avec l'état réel issu des Server Actions ;
 *   - la route `/demo/banque-connexion` le monte avec des états figés pour le
 *     Visual QA (Gate 4) — hors auth/DB, capturable en headless.
 *
 * Règles d'affichage (UI_GUIDELINES) :
 *   - Erreur = `text-danger` + `role="alert"` (le fond `danger-bg` est porté au
 *     niveau des états de page ; ici on reste sur le feedback inline court du
 *     widget, cohérent avec l'existant).
 *   - Succès = `text-success`, JAMAIS de rouge (réservé aux montants sortants).
 *   - Redirection (succès COMPLET) : message bref `role="status"`.
 *   - Succès sans redirection (partiel, ou flag `complet` pas encore exposé) :
 *     confirmation + lien d'action explicite vers le Dashboard (§2.3).
 */
import Link from "next/link";

/** Route du Dashboard de trésorerie (« l'accueil EST le dashboard »). */
export const ROUTE_DASHBOARD = "/";

/** Une connexion à réparer (signal `reparation` du serveur). Identifiants opaques. */
export interface ConnexionAReparer {
  connectionId: string;
  jobId: string;
}

/**
 * Une connexion à RECONNECTER (signal `aReconnecter` : 403 désalignement EndUser). À
 * la différence de `ConnexionAReparer`, il n'y a PAS de `jobId` : l'accès n'est plus
 * valide, on relance un parcours de connexion complet (pas une reprise MFA/REPAIR).
 */
export interface ConnexionAReconnecter {
  connectionId: string;
}

export function WidgetFeedback({
  erreurDemarrage,
  erreurWidget,
  erreurFinalisation,
  succes,
  redirection,
  reparation,
  onReconnecter,
  reparationEnCours,
  widgetOuvert,
  aReconnecter,
}: {
  /** Erreur de démarrage (LinkToken) — message déjà mappé S2, non énumérant. */
  erreurDemarrage?: string | null;
  /**
   * Erreur DU WIDGET NATIF (`onError` du CDN) — message déjà mappé S2 par
   * `messageErreurWidget`. Canal DISTINCT des deux autres : origine différente (le
   * widget, pas nos Server Actions) et rescue différente (réarmer et refaire le
   * parcours). Les confondre rendrait le diagnostic impossible en support.
   */
  erreurWidget?: string | null;
  /** Erreur de finalisation/synchro — message déjà mappé S2. */
  erreurFinalisation?: string | null;
  /** Message de succès (déjà construit côté serveur). */
  succes?: string | null;
  /** `true` quand une redirection vers le Dashboard est en cours (succès complet). */
  redirection?: boolean;
  /**
   * Connexions demandant une réparation MFA (le re-sync a redemandé un OTP). Chaque
   * entrée rend un bouton « Reconnecter » qui rouvre le widget natif en mode REPAIR.
   * Vide/absent = aucun bouton. Inerte si `onReconnecter` n'est pas fourni (Visual QA).
   */
  reparation?: ConnexionAReparer[];
  /** Clic sur « Reconnecter » d'une connexion → le parent ouvre le widget REPAIR. */
  onReconnecter?: (connexion: ConnexionAReparer) => void;
  /**
   * `true` entre le clic « Reconnecter » et l'obtention du token REPAIR : le bouton passe
   * en « Ouverture… » (anti-double-clic). SENS UNIQUE — ne PAS y verser « un widget est
   * ouvert » : le bouton afficherait « Ouverture… » alors que rien ne s'ouvre. C'est à ça
   * que sert `widgetOuvert`.
   */
  reparationEnCours?: boolean;
  /**
   * `true` dès qu'un widget est ouvert ou en cours d'ouverture (onboarding OU réparation).
   * DÉSACTIVE « Reconnecter » sans en changer le libellé : on ne peut pas ouvrir deux
   * widgets. Sans cette garde, « Reconnecter » démontait le widget ouvert sous les pieds
   * de l'utilisateur — ou avalait en silence un LinkToken d'onboarding encore en vol.
   */
  widgetOuvert?: boolean;
  /**
   * Connexions dont l'accès est DÉSALIGNÉ (403) : à reconnecter par un NOUVEAU parcours
   * de connexion (pas de REPAIR — aucun jobId). On affiche une invite dédiée pointant
   * vers le bouton « Connecter une banque ». Vide/absent = aucune invite.
   */
  aReconnecter?: ConnexionAReconnecter[];
}) {
  return (
    <>
      {erreurDemarrage && (
        <p role="alert" className="text-sm text-danger">
          {erreurDemarrage}
        </p>
      )}
      {/* Échec DU WIDGET (onError du CDN) : sans ceci, le widget se fermait sans un
          mot. Le message est déjà mappé (jamais le texte amont, qui peut porter de
          la PII) ; le code machine, lui, est parti au log côté launcher. */}
      {erreurWidget && (
        <p role="alert" className="text-sm text-danger">
          {erreurWidget}
        </p>
      )}
      {erreurFinalisation && (
        <p role="alert" className="text-sm text-danger">
          {erreurFinalisation}
        </p>
      )}

      {/* Redirection en cours (succès COMPLET) : message bref et annoncé. Le
          `router.push` du parent emmène vers le Dashboard ; ce repère reste le
          temps que la navigation s'effectue (le widget est démonté à l'arrivée). */}
      {redirection && (
        <p role="status" className="text-sm text-success">
          Connexion établie — redirection vers votre tableau de bord…
        </p>
      )}

      {/* Succès SANS redirection automatique : soit partiel (au moins un échec, on
          NE masque PAS derrière une navigation), soit le flag `complet` n'est pas
          encore exposé par le serveur. On confirme + on offre un lien EXPLICITE
          vers le Dashboard (§2.3 lien d'action) ; l'utilisateur reste maître. */}
      {!redirection && succes && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm text-success">{succes}</span>
          <Link
            href={ROUTE_DASHBOARD}
            className="text-sm font-semibold text-primary transition-colors
              hover:text-primary-600 hover:underline focus:outline-none
              focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            Voir mon tableau de bord →
          </Link>
        </div>
      )}

      {/* Boutons de RÉPARATION : une connexion dont le re-sync a redemandé un OTP. Le
          clic rouvre le widget natif en mode REPAIR (le widget gère l'OTP en interne).
          Action secondaire (§2.3), cohérente avec « Synchroniser mes comptes ». Rendu
          inerte sans `onReconnecter` (route de démo / Visual QA). */}
      {reparation && reparation.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {reparation.map((cx) => (
            <li key={`${cx.connectionId}:${cx.jobId}`}>
              <button
                type="button"
                onClick={() => onReconnecter?.(cx)}
                disabled={!onReconnecter || reparationEnCours || widgetOuvert}
                className="inline-flex h-9 items-center gap-1.5 rounded-control px-2
                  text-sm font-semibold text-primary transition-colors
                  hover:text-primary-600 hover:underline focus:outline-none
                  focus-visible:ring-2 focus-visible:ring-primary
                  focus-visible:ring-offset-2 disabled:opacity-48"
              >
                <IconeReconnecter />
                {reparationEnCours ? "Ouverture…" : "Reconnecter"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* DÉSALIGNEMENT ENDUSER (403) : l'accès de la banque n'est plus valide. À la
          différence de la réparation MFA, il n'y a pas de reprise possible — l'utilisateur
          doit REFAIRE une connexion via « Connecter une banque » ci-dessus. On l'énonce
          clairement (role=status, jamais un rouge de donnée §3.4) sans nommer la banque. */}
      {aReconnecter && aReconnecter.length > 0 && (
        <p role="status" className="text-sm text-text-muted">
          {aReconnecter.length === 1
            ? "L’accès d’une banque n’est plus valide : reconnectez-la via « Connecter une banque » ci-dessus."
            : `L’accès de ${aReconnecter.length} banque(s) n’est plus valide : reconnectez-les via « Connecter une banque » ci-dessus.`}
        </p>
      )}
    </>
  );
}

/** Icône « bouclier + flèche » (réparation/reconnexion sécurisée). Décorative. */
function IconeReconnecter() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 1.5 2.5 3.5v3.2c0 3 2.2 5.6 5.5 6.8 3.3-1.2 5.5-3.8 5.5-6.8V3.5L8 1.5Z" />
      <path d="M6 7.8 7.4 9.2 10.2 6" />
    </svg>
  );
}
