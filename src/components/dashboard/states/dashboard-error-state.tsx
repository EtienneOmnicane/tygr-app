/**
 * État ERREUR du dashboard — la synchronisation bancaire a échoué
 * (UI_GUIDELINES checklist §6.5, fraîcheur §3.7 « Reconnecter »).
 *
 * Sémantique stricte (§3.4) : une ERREUR système n'est JAMAIS un rouge de
 * sortie. Elle porte TOUJOURS les trois signaux — fond teinté `danger-bg`,
 * icône, et message — pour ne pas se confondre avec un montant `outflow`.
 * On n'emploie donc ni `outflow` ni `inflow` ici.
 *
 * Présentationnel pur. `onRetry` est OPTIONNEL et non câblé par défaut
 * (« CTA inerte pour le moment ») — placeholder du futur mode Repair (§3.7).
 */
import { StateCard, StateIllustration } from "./primitives";

export function DashboardErrorState({
  detail,
  onRetry,
}: {
  /** Message technique court à afficher sous le titre (optionnel). */
  detail?: string;
  /** Handler futur du CTA de reconnexion. Absent → bouton inerte (démo). */
  onRetry?: () => void;
}) {
  return (
    <StateCard
      className="flex flex-col items-center justify-center px-6 py-16 text-center"
      role="alert"
    >
      {/* Pastille d'erreur : fond + icône (signal 1 et 2 du §3.4) */}
      <span className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-danger-bg">
        <StateIllustration variant="error" className="h-9 w-9 text-danger" />
      </span>

      {/* Message (signal 3 du §3.4) */}
      <h2 className="text-base font-semibold text-text">
        La synchronisation a échoué
      </h2>
      <p className="mt-2 max-w-md text-sm text-text-muted">
        Nous n’avons pas pu récupérer vos dernières opérations bancaires. Vos
        données existantes restent intactes — il suffit de relancer la connexion.
      </p>

      {detail && (
        <p className="mt-3 max-w-md text-xs text-text-faint">{detail}</p>
      )}

      {/* CTA de reconnexion : bouton primaire (§2.3). Inerte si onRetry absent. */}
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 inline-flex h-10 items-center gap-2 rounded-control bg-primary
          px-4 text-sm font-semibold text-text-onink transition-colors
          hover:bg-primary-600 focus:outline-none focus-visible:ring-2
          focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        Reconnecter
      </button>
    </StateCard>
  );
}
