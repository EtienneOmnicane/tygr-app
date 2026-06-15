/**
 * État VIDE du dashboard (UI_GUIDELINES §4.4 « Empty states », checklist §6.5).
 * Jamais un « No data » sec : illustration outline légère + message ergonomique +
 * UN seul CTA (lien d'action `primary`, §2.3).
 *
 * Couvre DEUX cas selon `accountLabel` :
 *   - SANS `accountLabel` (cas réel du dashboard : AUCUNE banque connectée) →
 *     invite à connecter une première banque. CTA = lien vers /banques (widget).
 *   - AVEC `accountLabel` (compte connecté, 0 transaction synchronisée) → message
 *     « synchro en cours », CTA pour connecter un compte supplémentaire.
 *
 * Le CTA est FONCTIONNEL par défaut : un `next/link` vers /banques (page de
 * connexion bancaire). `onConnect` reste optionnel : s'il est fourni, on rend un
 * bouton qui l'appelle à la place (rétrocompat démo / handlers custom). Aucun
 * vert/rouge ici : pas de donnée à colorer (§3.1).
 */
import Link from "next/link";

import { StateCard, StateIllustration } from "./primitives";

const CLASSE_CTA =
  "mt-6 inline-flex items-center gap-1.5 rounded-control px-3 py-2 text-sm " +
  "font-semibold text-primary transition-colors hover:text-primary-600 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
  "focus-visible:ring-offset-2";

export function DashboardEmptyState({
  accountLabel,
  onConnect,
}: {
  /** Nom du compte connecté à mentionner (ex. « Compte courant »). Absent → aucune banque. */
  accountLabel?: string;
  /** Handler custom du CTA. Fourni → bouton qui l'appelle ; absent → lien vers /banques. */
  onConnect?: () => void;
}) {
  const aucuneBanque = !accountLabel;

  return (
    <StateCard className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <StateIllustration
        variant="empty"
        className="mb-6 h-20 w-20 text-text-faint"
      />

      <h2 className="text-base font-semibold text-text">
        {aucuneBanque
          ? "Connectez votre première banque"
          : "Aucune transaction pour l’instant"}
      </h2>

      <p className="mt-2 max-w-md text-sm text-text-muted">
        {aucuneBanque ? (
          <>
            Aucune banque n’est encore connectée à cet espace. Connectez un
            compte bancaire pour voir votre trésorerie s’afficher ici.
          </>
        ) : (
          <>
            Votre compte <span className="font-medium text-text">{accountLabel}</span>{" "}
            est bien connecté. Dès que les premières opérations seront
            synchronisées, votre trésorerie s’affichera ici.
          </>
        )}
      </p>

      {/* CTA unique (§2.3). Par défaut : lien vers /banques. Si onConnect fourni :
          bouton qui l'appelle (rétrocompat démo / handler custom). */}
      {onConnect ? (
        <button type="button" onClick={onConnect} className={CLASSE_CTA}>
          <span aria-hidden>+</span>
          {aucuneBanque ? "Connecter une banque" : "Connecter un autre compte"}
        </button>
      ) : (
        <Link href="/banques" className={CLASSE_CTA}>
          <span aria-hidden>+</span>
          {aucuneBanque ? "Connecter une banque" : "Connecter un autre compte"}
        </Link>
      )}
    </StateCard>
  );
}
