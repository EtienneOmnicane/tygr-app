"use client";

/**
 * Légende du camembert « Analyse par catégorie », POUR UNE devise. Une ligne par
 * part : pastille de couleur (même mapping rang→teinte que le donut, via
 * `couleurCategorie`), nom de catégorie, montant et pourcentage. Le survol est
 * PARTAGÉ avec le donut (piloté par la carte parente) : survoler une ligne met en
 * avant la part correspondante dans l'anneau, et inversement.
 *
 * Règle 8 / formatage : le montant vient de `formatMontant` (chaîne SQL, jamais de
 * float) et NE se tronque JAMAIS (`tabular-nums` + `whitespace-nowrap`) ; seul le
 * LIBELLÉ de catégorie peut tronquer. Le pourcentage vient de `pourcentPart`
 * (libellé de ratio — cul-de-sac float d'affichage, cf. ce module).
 *
 * TOUTES les parts sont listées (pas de « +N autres » : résumer imposerait une
 * addition de montants en JS, interdite règle 8). La queue au-delà de 8 catégories
 * et « Non catégorisé » partagent la teinte neutre (cf. `palette-categories`).
 *
 * Variation (L4) : chaque ligne porte une étiquette de variation vs la période
 * précédente (`variationPart`). Neutralité sémantique (UI_GUIDELINES) : le SENS est
 * porté par une FLÈCHE (▴/▾), JAMAIS par une couleur `inflow`/`outflow` (vert/rouge
 * réservés aux MONTANTS) — tokens neutres uniquement (`text-text-faint`).
 *
 * Présentationnel pur : aucun fetch, aucun état interne. `onSurvol` optionnel/inerte.
 */
import { formatMontant } from "@/lib/format-montant";
import type { OrigineCategorie, PartCategorie } from "@/server/insights/types";

import { couleurCategorie } from "./palette-categories";
import { pourcentPart } from "./pourcent-part";
import { variationPart } from "./variation-part";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Étiquette compacte de variation d'une part vs la période précédente. Colonne de
 * largeur fixe (alignement des lignes). Neutralité : flèche ▴/▾ pour le sens (jamais
 * une couleur), « nouv. » pour une catégorie absente de la période précédente, « – »
 * pour un écart arrondi à 0 %. Tokens neutres seulement.
 */
function BadgeVariation({
  montant,
  montantPrecedent,
}: {
  montant: string;
  montantPrecedent: string;
}) {
  const v = variationPart(montant, montantPrecedent);

  if (v.sens === "nouveau") {
    return (
      <span
        className="w-14 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-text-faint"
        title="Nouveau sur cette période"
      >
        nouv.
      </span>
    );
  }

  if (v.sens === "stable" || v.pourcent === null) {
    return (
      <span
        className="w-14 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-text-faint"
        aria-label="stable vs période précédente"
        title="Stable vs période précédente"
      >
        <span aria-hidden>–</span>
      </span>
    );
  }

  const fleche = v.sens === "hausse" ? "▴" : "▾";
  const libelle = v.sens === "hausse" ? "en hausse de" : "en baisse de";
  return (
    <span
      className="w-14 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-text-faint"
      aria-label={`${libelle} ${v.pourcent} vs période précédente`}
    >
      <span aria-hidden className="mr-0.5">
        {fleche}
      </span>
      <span aria-hidden>{v.pourcent}</span>
    </span>
  );
}

/**
 * Libellé humain de l'espace de noms d'une part (D2=c). Sert d'infobulle sur CHAQUE
 * ligne : la même catégorie peut légitimement apparaître deux fois (« Loyer » créé par
 * l'utilisateur et « Loyer » venu de la banque), et rien à l'écran ne le dirait sans ça.
 */
const ORIGINE_INFOBULLE: Record<OrigineCategorie, string> = {
  TYGR: "Votre catégorie (règle ou ventilation manuelle)",
  AMONT: "Catégorie bancaire — part non ventilée de vos opérations",
  AUCUNE: "Opérations que la banque n’a pas étiquetées",
};

/**
 * Marque d'origine, affichée UNIQUEMENT sur les parts venues de la banque. Asymétrie
 * VOLONTAIRE : après ce chantier, la catégorie attendue par défaut est celle de
 * l'utilisateur — baliser les deux doublerait le bruit d'une légende qui porte déjà
 * couleur, libellé, montant, pourcentage et variation. Ce qui mérite d'être signalé,
 * c'est ce que l'utilisateur n'a PAS classé lui-même.
 *
 * Tokens sémantiques uniquement (jamais de couleur en dur) ; `text-text-muted` plutôt
 * que `text-text-faint` — sur le fond teinté `surface-inset`, faint tombe sous le seuil
 * de contraste AA (un fond teinté rabote le contraste de ce qu'il porte).
 */
function MarqueOrigine({ origine }: { origine: OrigineCategorie }) {
  if (origine !== "AMONT") return null;
  return (
    <span
      className="shrink-0 rounded-control bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-text-muted"
      title={ORIGINE_INFOBULLE.AMONT}
    >
      banque
    </span>
  );
}

export function LegendeCategories({
  parts,
  devise,
  survol,
  onSurvol,
}: {
  parts: PartCategorie[];
  devise: string;
  /** Index de la part survolée (partagé avec le donut), ou null. */
  survol: number | null;
  onSurvol?: (index: number | null) => void;
}) {
  return (
    <ul className="flex flex-col gap-1.5" aria-label={`Répartition par catégorie en ${devise}`}>
      {parts.map((p, index) => {
        const couleur = couleurCategorie(index, p.estNonCategorise);
        // Estompage miroir du donut : hors survol, la ligne active reste pleine,
        // les autres passent à 0.45 (un poil plus lisible qu'un secteur — c'est du texte).
        const estix = survol === null || survol === index;
        return (
          <li
            key={`${p.categorie}-${index}`}
            onMouseEnter={() => onSurvol?.(index)}
            onMouseLeave={() => onSurvol?.(null)}
            className={cn(
              "flex items-center gap-3 rounded-control px-2 py-1 transition-opacity",
              survol === index && "bg-surface-inset",
            )}
            style={{ opacity: estix ? 1 : 0.45 }}
          >
            {/* Pastille de teinte (mapping rang→couleur, identique au secteur du donut). */}
            <span
              aria-hidden
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: couleur }}
            />

            {/* Libellé : SEUL élément autorisé à tronquer (règle formatage).
                L'infobulle nomme aussi l'ORIGINE — sans quoi deux parts homonymes
                d'espaces de noms différents seraient indiscernables. */}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                p.estNonCategorise ? "italic text-text-muted" : "text-text",
              )}
              title={`${p.categorie} — ${ORIGINE_INFOBULLE[p.origine]}`}
            >
              {p.categorie}
            </span>

            {/* Origine : marque discrète sur les parts venues de la banque. */}
            <MarqueOrigine origine={p.origine} />

            {/* Montant : jamais tronqué (tabular-nums + nowrap, colonne dimensionnée). */}
            <span className="shrink-0 whitespace-nowrap text-sm font-medium tabular-nums text-text">
              {formatMontant(p.montant, devise)}
            </span>

            {/* Pourcentage de la part (dans SA devise). */}
            <span className="w-12 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-text-faint">
              {pourcentPart(p.part)}
            </span>

            {/* Variation vs période précédente (flèche neutre, jamais de couleur). */}
            <BadgeVariation
              montant={p.montant}
              montantPrecedent={p.montantPrecedent}
            />
          </li>
        );
      })}
    </ul>
  );
}
