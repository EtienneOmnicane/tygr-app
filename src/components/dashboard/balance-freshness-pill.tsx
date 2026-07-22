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
 *
 * ⚠️ CONTRASTE — la couleur vit dans le POINT, pas dans le texte (A11Y-VERT-SUCCES1).
 * `text-success` (#1d9e55) plafonne à 3,46:1 : conforme pour un objet GRAPHIQUE (seuil
 * 3:1, WCAG 1.4.11), insuffisant pour du TEXTE (seuil AA 4,5:1). Le libellé passe donc
 * en `text-text` et le point coloré porte seul le niveau. Traitement UNIFORME aux trois
 * niveaux — y compris `warning`/`danger`, qui passeraient pourtant l'AA : faire varier
 * la règle selon le niveau rendrait « frais » visuellement plus faible que « périmé »
 * pour une raison purement technique, et l'utilisateur lirait ça comme une hiérarchie.
 * Le niveau reste lisible sans la couleur (point + libellé « il y a 3 j »), ce qui
 * satisfait aussi 1.4.1 (l'information ne passe pas par la seule couleur).
 *
 * Le CTA « Reconnecter » est OPT-OUT (`ctaReconnexion={false}`). Sur la page
 * /banques, il pointerait vers la page courante ET contredirait le badge
 * « Connectée » (la connexion est active, seule la donnée est périmée — le geste juste
 * y est « Synchroniser mes comptes », déjà présent). Sur le Dashboard, la réparation
 * vit aussi sur /banques et « Synchroniser » reste en tête : le CTA y est donc masqué
 * (demande produit). Le défaut du composant reste `true` pour tout futur consommateur.
 */
import Link from "next/link";

import type { Fraicheur, NiveauFraicheur } from "@/lib/format-date";
import { cn } from "@/components/ui/states/primitives";

/** Le niveau ne colore QUE le point (cf. docstring : contraste). */
const COULEUR_POINT: Record<NiveauFraicheur, string> = {
  frais: "bg-success",
  recent: "bg-warning",
  perime: "bg-danger",
};

export function BalanceFreshnessPill({
  fraicheur,
  compteLabel,
  reconnectHref = "/banques",
  ctaReconnexion = true,
}: {
  /** Fraîcheur déjà calculée (`formaterFraicheurRelative`). */
  fraicheur: Fraicheur;
  /** Compte concerné — enrichit le tooltip (« … · MCB »). Optionnel. */
  compteLabel?: string | null;
  /** Cible du CTA Reconnecter (mode Repair ≥24h). Défaut : /banques. */
  reconnectHref?: string;
  /**
   * Affiche le CTA « Reconnecter » quand la donnée est périmée (≥24h). Défaut `true` ;
   * passé à `false` par les deux consommateurs actuels (page /banques ET Dashboard),
   * cf. docstring en tête de fichier pour le raisonnement de chacun.
   */
  ctaReconnexion?: boolean;
}) {
  const { niveau, libelle, horodatageAbsolu } = fraicheur;
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
        className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs
          font-medium text-text"
      >
        <span
          aria-hidden
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            COULEUR_POINT[niveau],
          )}
        />
        {libelle}
        {/* Horodatage ABSOLU (Maurice) EN CLAIR (FB0709-SYNC-HEURE-MU1) : le relatif
            seul (« il y a 2 h ») obligeait à survoler le tooltip pour dater la
            synchro. Reste en retrait (`text-muted`) : c'est la précision, pas le
            message — la hiérarchie ne passe plus par la couleur du niveau. */}
        <span className="font-normal text-text-muted">
          · {horodatageAbsolu}
        </span>
      </span>
      {perime && ctaReconnexion && (
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
