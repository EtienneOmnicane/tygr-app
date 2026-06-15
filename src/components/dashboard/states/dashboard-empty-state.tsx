/**
 * État VIDE du dashboard — un compte bancaire est connecté mais aucune
 * transaction n'a encore été synchronisée (UI_GUIDELINES §4.4 « Empty states »,
 * checklist §6.5). Jamais un « No data » sec : illustration outline légère +
 * message ergonomique + UN seul CTA (lien d'action `primary`, §2.3).
 *
 * Présentationnel pur. `onConnect` est OPTIONNEL et non câblé par défaut
 * (« inerte pour le moment ») — il n'existe que pour brancher la suite sans
 * retoucher le markup. Aucun vert/rouge ici : pas de donnée à colorer (§3.1).
 */
import { StateCard, StateIllustration } from "./primitives";

export function DashboardEmptyState({
  accountLabel,
  onConnect,
}: {
  /** Nom du compte connecté à mentionner dans le message (ex. « Compte courant »). */
  accountLabel?: string;
  /** Handler futur du CTA. Absent → bouton inerte (démo). */
  onConnect?: () => void;
}) {
  return (
    <StateCard className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <StateIllustration
        variant="empty"
        className="mb-6 h-20 w-20 text-text-faint"
      />

      <h2 className="text-base font-semibold text-text">
        Aucune transaction pour l’instant
      </h2>

      <p className="mt-2 max-w-md text-sm text-text-muted">
        {accountLabel ? (
          <>
            Votre compte <span className="font-medium text-text">{accountLabel}</span>{" "}
            est bien connecté. Dès que les premières opérations seront
            synchronisées, votre trésorerie s’affichera ici.
          </>
        ) : (
          <>
            Votre compte bancaire est bien connecté. Dès que les premières
            opérations seront synchronisées, votre trésorerie s’affichera ici.
          </>
        )}
      </p>

      {/* CTA unique : lien d'action primary (§2.3). Inerte si onConnect absent. */}
      <button
        type="button"
        onClick={onConnect}
        className="mt-6 inline-flex items-center gap-1.5 rounded-control px-3 py-2
          text-sm font-semibold text-primary transition-colors hover:text-primary-600
          focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
          focus-visible:ring-offset-2"
      >
        <span aria-hidden>+</span>
        Connecter un autre compte
      </button>
    </StateCard>
  );
}
