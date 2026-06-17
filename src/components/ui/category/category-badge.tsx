/**
 * CategoryBadge — pastille catégorie (couleur + label). Brique FONDATRICE du
 * Pilier 1 (catégorisation), transverse : réutilisée par la table du dashboard,
 * le CategoryPicker, le CategoryManagerModal et la matrice à venir.
 *
 * Présentationnel PUR : aucune donnée fetchée, aucun état, aucune Server Action.
 *
 * ⚠️ COULEUR — décision design (plan-ceo-review 2026-06-17, §A4) : la palette
 * catégorielle est une série NEUTRE DÉDIÉE (bleus / violets / ambres / sarcelles),
 * qui EXCLUT le vert et le rouge — ceux-ci sont réservés à la donnée financière
 * (inflow/outflow, UI_GUIDELINES §3.1). Colorer une catégorie « Ventes » en vert
 * créerait une collision sémantique (sortie vs catégorie). Étanchéité stricte.
 *
 * La table `categories` ne stocke PAS de couleur : on l'attribue ici de façon
 * DÉTERMINISTE à partir d'un identifiant stable (hash → index de palette), donc
 * une même catégorie a toujours la même teinte, sans persistance. Si le schéma
 * gagne un jour une colonne couleur, `colorKey` permet de la forcer.
 */
import type { ReactNode } from "react";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Palette catégorielle — paires {bg pastel, texte 700} pour contraste AA sur
 * fond clair, alignées sur l'esprit des badges de statut (§3.6 : fond pastel +
 * texte foncé, jamais saturé). AUCUN vert ni rouge (réservés à la donnée, §3.1).
 *
 * ⚠️ Décision Visual QA (2026-06-17) : la sarcelle (#115E59) et le cyan (#155E75)
 * ont été RETIRÉS — ce sont des verts-bleus qui se lisent comme du vert à l'écran
 * (confusion avec inflow, aggravée à côté du bouton `success`). Remplacés par
 * bleu-acier et brun-terre, franchement non-ambigus. Teintes finales : indigo,
 * violet, ambre, bleu-acier, brun, rose, ardoise, fuchsia.
 */
const PALETTE_CATEGORIE = [
  { bg: "bg-[#EEF2FF]", text: "text-[#3730A3]" }, // indigo
  { bg: "bg-[#F5F3FF]", text: "text-[#6D28D9]" }, // violet
  { bg: "bg-[#FFFAEB]", text: "text-[#B54708]" }, // ambre
  { bg: "bg-[#EFF4FF]", text: "text-[#1E3A8A]" }, // bleu-acier (ex-cyan)
  { bg: "bg-[#FAF6F2]", text: "text-[#7C4A21]" }, // brun-terre (ex-sarcelle)
  { bg: "bg-[#FDF2FA]", text: "text-[#9D174D]" }, // rose
  { bg: "bg-[#F8FAFC]", text: "text-[#334155]" }, // ardoise
  { bg: "bg-[#FAF5FF]", text: "text-[#86198F]" }, // fuchsia
] as const;

/** Nombre de teintes — exporté pour les tests de déterminisme. */
export const NB_TEINTES_CATEGORIE = PALETTE_CATEGORIE.length;

/**
 * Hash déterministe (djb2 tronqué) d'une clé → index de palette. Stable : la même
 * clé donne toujours la même teinte, indépendamment du rendu ou de la session.
 */
export function indexTeinteCategorie(cle: string): number {
  let h = 5381;
  for (let i = 0; i < cle.length; i++) {
    h = ((h << 5) + h + cle.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % PALETTE_CATEGORIE.length;
}

export function CategoryBadge({
  name,
  colorKey,
  size = "md",
  className,
  icon,
}: {
  /** Nom affiché de la catégorie (ex. « Électricité »). */
  name: string;
  /**
   * Clé de couleur déterministe. Défaut = le `name` lui-même. Passer l'`id` de
   * catégorie quand il est dispo (stable même si la catégorie est renommée).
   */
  colorKey?: string;
  /** `sm` pour les tables denses (§2.2), `md` par défaut. */
  size?: "sm" | "md";
  className?: string;
  /** Glyphe optionnel à gauche du label (ex. point coloré, icône de nature). */
  icon?: ReactNode;
}) {
  const teinte = PALETTE_CATEGORIE[indexTeinteCategorie(colorKey ?? name)];
  const taille =
    size === "sm"
      ? "px-2 py-0.5 text-[11px] gap-1"
      : "px-2.5 py-1 text-xs gap-1.5";

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full font-medium",
        teinte.bg,
        teinte.text,
        taille,
        className,
      )}
    >
      {icon}
      <span className="truncate">{name}</span>
    </span>
  );
}
