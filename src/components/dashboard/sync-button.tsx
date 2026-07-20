"use client";

/**
 * DÉCLENCHEUR « Synchroniser » du dashboard (L8a). Réduit à un bouton : il appelle la
 * synchro via le contexte (`SynchroProvider`) et n'affiche plus AUCUN compte rendu.
 *
 * Pourquoi ce partage (refonte UX 2026-07-20) : le compte rendu vivait ICI, donc il
 * héritait forcément de la position du bouton — cluster droit du header — d'où le « mur
 * de texte gris » aligné à droite en `text-xs`, qui empilait 4 états sans hiérarchie et
 * noyait les deux actions. Il vit désormais dans `SyncSummary`, sous le header, aligné à
 * gauche et en largeur bornée. L'état est partagé par le contexte parce que les deux
 * morceaux occupent deux positions distinctes de l'arbre.
 *
 * Sécurité (rappel) : la VRAIE garde est SERVEUR — `synchroniserConnexionsDepuisOmnifi`
 * refuse un VIEWER en `ConnexionNonAutoriseeError` (orchestration.ts, sous le `ctx.role`
 * re-résolu par withWorkspace). Le gating `peutModifier` ci-dessous n'est qu'un CONFORT
 * UX (VIEWER = bouton visible mais inerte + tooltip), pattern identique à `bank-cta.tsx`.
 */
import type { WorkspaceRole } from "@/server/db/schema";
import { peutModifier } from "@/lib/permissions";
import { cn } from "@/components/ui/states/primitives";
import { IconeSynchro } from "@/components/ui/icons/icone-synchro";
import { useSynchro } from "@/components/sync/sync-contexte";

export function SyncButton({ role }: { role: WorkspaceRole }) {
  const { enCours, synchroniser } = useSynchro();

  // VIEWER : bouton VISIBLE mais inerte (span aria-disabled + tooltip), jamais un
  // <button> mort — même pattern que `bank-cta.tsx`. La barrière réelle est serveur.
  if (!peutModifier(role)) {
    return (
      <span
        aria-disabled
        title="Votre rôle (lecture seule) ne permet pas de synchroniser les comptes."
        className="inline-flex cursor-default items-center gap-1.5 text-xs
          font-semibold text-text-faint"
      >
        <IconeSynchro className="h-3.5 w-3.5" />
        Synchroniser
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={synchroniser}
      disabled={enCours}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-semibold text-primary",
        "transition-colors hover:text-primary-600 disabled:opacity-48",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        "focus-visible:ring-offset-2 rounded-[2px]",
      )}
    >
      <IconeSynchro
        className={cn("h-3.5 w-3.5", enCours && "motion-safe:animate-spin")}
      />
      {enCours ? "Synchronisation…" : "Synchroniser"}
    </button>
  );
}
