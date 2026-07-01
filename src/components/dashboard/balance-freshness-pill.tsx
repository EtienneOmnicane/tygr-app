/**
 * Pastille de FRAÎCHEUR du solde courant (UI_GUIDELINES §3.7). Présentationnel
 * PUR : reçoit une `Fraicheur` déjà calculée (niveau + libellé + horodatage absolu)
 * et la rend. AUCUN calcul de temps ici (le delta est fait par
 * `formaterFraicheurRelative`, source unique — CLAUDE.md « Formatage »).
 *
 * C'est la VRAIE réponse à DR-F3/C3/C4 : on qualifie l'âge de la donnée instantanée
 * (solde courant), on n'affiche plus « au JJ/MM » dérivé d'un EOD de courbe.
 *
 * Sémantique des couleurs (§3.7, ≠ §3.4) : success/warning/danger portent un ÉTAT
 * SYSTÈME (fraîcheur), pas une donnée financière — donc jamais inflow/outflow. Le
 * rouge `perime` (≥24h) déclenche le mode Repair : CTA « Reconnecter » vers /banques.
 */
import Link from "next/link";

import type { Fraicheur, NiveauFraicheur } from "@/lib/format-date";
import { cn } from "@/components/ui/states/primitives";

const STYLES: Record<
  NiveauFraicheur,
  { dot: string; texte: string }
> = {
  frais: { dot: "bg-success", texte: "text-success" },
  recent: { dot: "bg-warning", texte: "text-warning" },
  perime: { dot: "bg-danger", texte: "text-danger" },
};

export function BalanceFreshnessPill({
  fraicheur,
  compteLabel,
  reconnectHref = "/banques",
}: {
  /** Fraîcheur déjà calculée (`formaterFraicheurRelative`). */
  fraicheur: Fraicheur;
  /** Compte concerné — enrichit le tooltip (« … · MCB »). Optionnel. */
  compteLabel?: string | null;
  /** Cible du CTA Reconnecter (mode Repair ≥24h). Défaut : /banques. */
  reconnectHref?: string;
}) {
  const { niveau, libelle, horodatageAbsolu } = fraicheur;
  const style = STYLES[niveau];
  const perime = niveau === "perime";
  // Tooltip : horodatage absolu Maurice + compte concerné si fourni.
  const tooltip = compteLabel
    ? `Dernière synchro : ${horodatageAbsolu} · ${compteLabel}`
    : `Dernière synchro : ${horodatageAbsolu}`;

  return (
    <span className="inline-flex items-center gap-2">
      <span
        // role=status seulement quand l'état mérite attention (donnée périmée) :
        // un lecteur d'écran l'annonce sans spammer sur l'état nominal « frais ».
        role={perime ? "status" : undefined}
        title={tooltip}
        className={cn(
          "inline-flex items-center gap-1.5 text-xs font-medium",
          style.texte,
        )}
      >
        <span
          aria-hidden
          className={cn("h-2 w-2 shrink-0 rounded-full", style.dot)}
        />
        {libelle}
      </span>
      {perime && (
        <Link
          href={reconnectHref}
          className={cn(
            "text-xs font-semibold text-primary underline-offset-2 hover:underline",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            "focus-visible:ring-offset-2 rounded-[2px]",
          )}
        >
          Reconnecter
        </Link>
      )}
    </span>
  );
}
