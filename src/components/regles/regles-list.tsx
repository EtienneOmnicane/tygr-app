"use client";

/**
 * Liste des règles de catégorisation. Présentationnel : reçoit les règles (déjà
 * ordonnées par le conteneur : actives dans l'ordre d'application, archivées ensuite)
 * + un dictionnaire id→nom de catégorie + des handlers. Rend chaque règle en phrase
 * lisible : « Si le libellé CONTIENT “EDF” → Énergie ».
 *
 * PRIORITÉ = position (réordonnancement) : la règle du HAUT gagne. Pilotée par
 * glisser-déposer (drag HTML5 natif, zéro dépendance) ET par des flèches ↑/↓ (chemin
 * accessible au clavier). Seules les règles ACTIVES sont réordonnables.
 *
 * « Modifier » est offert sur TOUTES les règles (y compris archivées → seul chemin de
 * réactivation via la case « Règle active » du formulaire). « Supprimer » (= archiver)
 * ne concerne que les actives. Aucune couleur en dur ; vert/rouge réservés à la DONNÉE.
 */
import { CategoryBadge } from "@/components/ui/category";

import type { RegleUI, RuleMatchType } from "./types-regles";

function libelleMatch(matchType: RuleMatchType): string {
  return matchType === "starts_with" ? "commence par" : "contient";
}

/** Poignée de glisser (grip) — SVG inline, pas de dépendance d'icônes. */
function GripIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <circle cx="5" cy="3" r="1.3" />
      <circle cx="11" cy="3" r="1.3" />
      <circle cx="5" cy="8" r="1.3" />
      <circle cx="11" cy="8" r="1.3" />
      <circle cx="5" cy="13" r="1.3" />
      <circle cx="11" cy="13" r="1.3" />
    </svg>
  );
}

/** Déplace `idTire` juste avant `idCible` dans l'ordre des actifs. */
function ordreApresDrop(
  ids: string[],
  idTire: string,
  idCible: string,
): string[] {
  if (idTire === idCible) return ids;
  const sansTire = ids.filter((id) => id !== idTire);
  const posCible = sansTire.indexOf(idCible);
  if (posCible === -1) return ids;
  return [...sansTire.slice(0, posCible), idTire, ...sansTire.slice(posCible)];
}

/** Échange l'élément `id` avec son voisin dans la direction donnée. */
function ordreApresSwap(
  ids: string[],
  id: string,
  direction: "haut" | "bas",
): string[] {
  const i = ids.indexOf(id);
  if (i === -1) return ids;
  const j = direction === "haut" ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return ids;
  const copie = [...ids];
  [copie[i], copie[j]] = [copie[j], copie[i]];
  return copie;
}

export function ReglesList({
  regles,
  nomParCategorie,
  onSupprimer,
  suppressionEnCours,
  onModifier,
  onReordonner,
  idsActifsOrdonnes = [],
  reordreEnCours = false,
  idEnEdition = null,
  peutGerer = true,
}: {
  regles: RegleUI[];
  /** id catégorie → nom lisible (le conteneur le construit depuis listerCategories). */
  nomParCategorie: Map<string, string>;
  /** Archive la règle (« supprimer »). Le conteneur appelle l'action. */
  onSupprimer: (ruleId: string) => void;
  /** id de la règle en cours de suppression (désactive son bouton), si une. */
  suppressionEnCours?: string | null;
  /** Ouvre l'édition de la règle (pré-remplit le formulaire du conteneur). */
  onModifier?: (regle: RegleUI) => void;
  /** Remonte le nouvel ordre des règles ACTIVES (ids) après drag/flèche. */
  onReordonner?: (nouvelOrdreActifs: string[]) => void;
  /** ids des règles actives dans l'ordre courant (source du réordonnancement). */
  idsActifsOrdonnes?: string[];
  /** true pendant l'appel serveur de réordonnancement (désactive les poignées). */
  reordreEnCours?: boolean;
  /** id de la règle actuellement éditée (mise en évidence), si une. */
  idEnEdition?: string | null;
  /** false = lecture seule (VIEWER) : pas de boutons ni de réordonnancement. */
  peutGerer?: boolean;
}) {
  const reordonnable = peutGerer && typeof onReordonner === "function";

  function auDrop(idCible: string, e: React.DragEvent) {
    e.preventDefault();
    const idTire = e.dataTransfer.getData("text/plain");
    if (!idTire || !onReordonner) return;
    const nouvel = ordreApresDrop(idsActifsOrdonnes, idTire, idCible);
    if (nouvel.join() !== idsActifsOrdonnes.join()) onReordonner(nouvel);
  }

  function deplacer(id: string, direction: "haut" | "bas") {
    if (!onReordonner) return;
    const nouvel = ordreApresSwap(idsActifsOrdonnes, id, direction);
    if (nouvel.join() !== idsActifsOrdonnes.join()) onReordonner(nouvel);
  }

  return (
    <ul className="flex flex-col divide-y divide-line rounded-control border border-line bg-surface-card">
      {regles.map((regle) => {
        const nomCat = nomParCategorie.get(regle.categoryId) ?? "Catégorie inconnue";
        const enSuppression = suppressionEnCours === regle.id;
        const glissable = reordonnable && regle.isActive && !reordreEnCours;
        const posActif = idsActifsOrdonnes.indexOf(regle.id);
        const estPremier = posActif === 0;
        const estDernier = posActif === idsActifsOrdonnes.length - 1;
        return (
          <li
            key={regle.id}
            draggable={glissable}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", regle.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (glissable) e.preventDefault();
            }}
            onDrop={(e) => auDrop(regle.id, e)}
            className={
              "flex items-center gap-3 px-4 py-3 " +
              (regle.id === idEnEdition ? "bg-surface-inset" : "")
            }
          >
            {/* Poignée + flèches (règles actives réordonnables). */}
            {reordonnable && regle.isActive && (
              <div className="flex shrink-0 items-center gap-1">
                <span
                  className={
                    "text-text-faint " +
                    (glissable ? "cursor-grab" : "cursor-not-allowed opacity-[0.48]")
                  }
                  title="Glisser pour changer la priorité"
                >
                  <GripIcon />
                </span>
                <div className="flex flex-col">
                  <button
                    type="button"
                    aria-label="Monter la règle (priorité plus haute)"
                    disabled={estPremier || reordreEnCours}
                    onClick={() => deplacer(regle.id, "haut")}
                    className="rounded px-1 text-text-muted transition-colors hover:bg-surface-inset
                      hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
                      disabled:cursor-not-allowed disabled:opacity-[0.36]"
                  >
                    <span aria-hidden className="text-[11px] leading-none">▲</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Descendre la règle (priorité plus basse)"
                    disabled={estDernier || reordreEnCours}
                    onClick={() => deplacer(regle.id, "bas")}
                    className="rounded px-1 text-text-muted transition-colors hover:bg-surface-inset
                      hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
                      disabled:cursor-not-allowed disabled:opacity-[0.36]"
                  >
                    <span aria-hidden className="text-[11px] leading-none">▼</span>
                  </button>
                </div>
              </div>
            )}

            {/* Numéro d'ordre VISIBLE (FB0709-REGLES-PRIORITE-AIDE1) : la priorité
                est la position — on l'affiche (1 = appliquée en premier), y compris
                en lecture seule (VIEWER, sans poignées). Archivées : pas de numéro. */}
            {regle.isActive && posActif !== -1 && (
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full
                  bg-surface-inset text-[11px] font-semibold tabular-nums text-text-muted"
                title={`Priorité ${posActif + 1} — appliquée en ${posActif === 0 ? "premier" : `position ${posActif + 1}`}`}
              >
                {posActif + 1}
              </span>
            )}

            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="text-text-muted">Si le libellé</span>
              <span className="font-medium text-text">{libelleMatch(regle.matchType)}</span>
              <span className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-[13px] text-text">
                {regle.pattern}
              </span>
              <span aria-hidden className="text-text-faint">
                →
              </span>
              <CategoryBadge name={nomCat} colorKey={regle.categoryId} size="sm" />
              {!regle.isActive && (
                <span className="rounded-full bg-surface-inset px-2 py-0.5 text-[11px] font-medium text-text-muted">
                  archivée
                </span>
              )}
            </div>

            {peutGerer && (
              <div className="flex shrink-0 items-center gap-1">
                {onModifier && (
                  <button
                    type="button"
                    onClick={() => onModifier(regle)}
                    className="rounded-control px-2.5 py-1.5 text-xs font-medium text-text-muted
                      transition-colors hover:bg-surface-inset hover:text-text
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    Modifier
                  </button>
                )}
                {regle.isActive && (
                  <button
                    type="button"
                    onClick={() => onSupprimer(regle.id)}
                    disabled={enSuppression}
                    className="rounded-control px-2.5 py-1.5 text-xs font-medium text-text-muted
                      transition-colors hover:bg-danger-bg hover:text-danger
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
                      disabled:opacity-[0.48]"
                  >
                    {enSuppression ? "Suppression…" : "Supprimer"}
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
