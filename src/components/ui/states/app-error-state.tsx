/**
 * État ERREUR applicatif TRANSVERSE (UI_GUIDELINES §3.4) — affiché par les
 * error boundaries (`error.tsx`, `global-error.tsx`) quand le rendu d'un segment
 * échoue (typiquement une panne d'infra : base injoignable, timeout Neon).
 *
 * Sémantique stricte (§3.4) : une ERREUR système n'est JAMAIS un rouge de sortie.
 * Trois signaux obligatoires — fond `danger-bg`, icône, message — pour ne pas se
 * confondre avec un montant `outflow`. Ni `outflow` ni `inflow` ici. `role="alert"`.
 *
 * Présentationnel pur : aucun fetch, aucun état. Le handler `onRetry` (branché
 * sur `unstable_retry`/`reset` de Next par l'error boundary) ré-essaie le rendu.
 *
 * PII (règle 8) : ce composant n'affiche JAMAIS `error.message` brut. L'appelant
 * ne lui passe qu'un `reference` opaque (le `digest` Next) pour corréler aux logs.
 */
import { StateCard, StateIllustration } from "./primitives";

export function AppErrorState({
  reference,
  onRetry,
}: {
  /** Identifiant opaque de corrélation (digest Next), jamais un message brut. */
  reference?: string;
  /** Re-tente le rendu du segment (unstable_retry/reset de l'error boundary). */
  onRetry?: () => void;
}) {
  return (
    <StateCard
      className="mx-auto flex max-w-md flex-col items-center justify-center px-6 py-16 text-center"
      role="alert"
    >
      {/* Pastille d'erreur : fond + icône (signaux 1 et 2 du §3.4) */}
      <span className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-danger-bg">
        <StateIllustration variant="error" className="h-9 w-9 text-danger" />
      </span>

      {/* Message (signal 3) — générique, non technique, sans PII. */}
      <h2 className="text-base font-semibold text-text">
        Service momentanément indisponible
      </h2>
      <p className="mt-2 max-w-md text-sm text-text-muted">
        Nous n’avons pas pu charger cette page. Vos données sont en sécurité —
        il s’agit le plus souvent d’un incident temporaire. Réessayez dans
        quelques instants.
      </p>

      {reference && (
        <p className="mt-3 max-w-md text-xs text-text-faint">
          Référence incident : {reference}
        </p>
      )}

      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 inline-flex h-10 items-center gap-2 rounded-control bg-primary
            px-4 text-sm font-semibold text-text-onink transition-colors
            hover:bg-primary-600 focus:outline-none focus-visible:ring-2
            focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          Réessayer
        </button>
      )}
    </StateCard>
  );
}
