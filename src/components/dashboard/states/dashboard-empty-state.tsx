/**
 * État VIDE du dashboard (UI_GUIDELINES §4.4 « Empty states », checklist §6.5).
 * Fine SPÉCIALISATION du `EmptyState` générique (UI-ES1) : ce composant ne fait
 * que choisir la copy / le libellé de CTA selon son domaine, puis délègue TOUT le
 * rendu (carte, illustration, titre, message, CTA) à `<EmptyState>`. Aucun markup
 * dupliqué ici (avant UI-ES1, il reclonait StateCard + illustration + classe CTA).
 *
 * Couvre DEUX cas selon `accountLabel` :
 *   - SANS `accountLabel` (cas réel du dashboard : AUCUNE banque connectée) →
 *     invite à connecter une première banque. CTA → /banques (widget).
 *   - AVEC `accountLabel` (compte connecté, 0 transaction synchronisée) → message
 *     « synchro en cours », CTA pour connecter un compte supplémentaire.
 *
 * Le CTA est FONCTIONNEL par défaut : un lien vers /banques. `onConnect` reste
 * optionnel : fourni → CTA `button` qui l'appelle (rétrocompat démo / handler
 * custom), via la forme `{ label, onClick }` de l'union `EmptyStateCta`.
 */
import { EmptyState, type EmptyStateCta } from "@/components/ui/states";

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

  const ctaLabel = aucuneBanque
    ? "Connecter une banque"
    : "Connecter un autre compte";

  // Lien fonctionnel par défaut (/banques) ; bouton si un handler custom est fourni.
  const cta: EmptyStateCta = onConnect
    ? { label: ctaLabel, onClick: onConnect }
    : { label: ctaLabel, href: "/banques" };

  return (
    <EmptyState
      title={
        aucuneBanque
          ? "Connectez votre première banque"
          : "Aucune transaction pour l’instant"
      }
      message={
        aucuneBanque ? (
          <>
            Aucune banque n’est encore connectée à cet espace. Connectez un
            compte bancaire pour voir votre trésorerie s’afficher ici.
          </>
        ) : (
          <>
            Votre compte{" "}
            <span className="font-medium text-text">{accountLabel}</span> est
            bien connecté. Dès que les premières opérations seront synchronisées,
            votre trésorerie s’affichera ici.
          </>
        )
      }
      cta={cta}
    />
  );
}
