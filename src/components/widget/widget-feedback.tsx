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

export function WidgetFeedback({
  erreurDemarrage,
  erreurFinalisation,
  succes,
  redirection,
}: {
  /** Erreur de démarrage (LinkToken) — message déjà mappé S2, non énumérant. */
  erreurDemarrage?: string | null;
  /** Erreur de finalisation/synchro — message déjà mappé S2. */
  erreurFinalisation?: string | null;
  /** Message de succès (déjà construit côté serveur). */
  succes?: string | null;
  /** `true` quand une redirection vers le Dashboard est en cours (succès complet). */
  redirection?: boolean;
}) {
  return (
    <>
      {erreurDemarrage && (
        <p role="alert" className="text-sm text-danger">
          {erreurDemarrage}
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
    </>
  );
}
