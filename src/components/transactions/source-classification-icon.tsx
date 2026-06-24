/**
 * Icône de SOURCE de classification amont (concept C) — repère DISCRET posé en fin du
 * sous-texte « compte · catégorie » d'une ligne. Présentationnel PUR.
 *
 * Deux glyphes (cf. `regle-fiabilite.descriptionSource`) :
 *  - ⚙ « règle »  → USER_RULE / SYSTEM_RULE (mécanisme déterministe Omni-FI),
 *  - 🤖 « modèle » → ML_FALLBACK (origine probabiliste).
 * Rien n'est rendu si la source est inconnue/non remontée.
 *
 * ⚠️ NEUTRE : `text-text-muted`, AUCUNE couleur sémantique (ni inflow/outflow ni
 * warning) — c'est un repère de provenance, pas un statut. Ne se confond pas avec le
 * badge « À vérifier » (ambre) ni avec la ventilation manuelle.
 *
 * Accessibilité : le glyphe est `aria-hidden` ; le libellé complet est porté par un
 * `title` (survol) ET un `<span class="sr-only">` (lecteur d'écran) — une icône seule
 * n'est pas annoncée. Le libellé dit « Omni-FI », jamais « par l'utilisateur » (le
 * concept C n'est pas la saisie manuelle TYGR).
 */
import {
  descriptionSource,
  type GlypheSource,
} from "./regle-fiabilite";
import type { SourceClassification } from "./types-transactions";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Engrenage outline — variante « règle » (SVG inline, pas de lucide). */
function IconeRegle() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
    </svg>
  );
}

/** Puce/processeur outline — variante « modèle » (ML). */
function IconeModele() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
      <path d="M6.5 6.5h3v3h-3z" />
      <path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2" />
    </svg>
  );
}

function Glyphe({ glyphe }: { glyphe: GlypheSource }) {
  return glyphe === "modele" ? <IconeModele /> : <IconeRegle />;
}

export function SourceClassificationIcon({
  source,
  className,
}: {
  source: SourceClassification | null;
  className?: string;
}) {
  const desc = descriptionSource(source);
  if (!desc) return null;
  return (
    <span
      // `shrink-0` : l'icône ne doit jamais être rognée par le `truncate` du sous-texte
      // voisin (anti-chevauchement R3). `align-middle` pour s'asseoir sur la ligne de texte.
      className={cn(
        "inline-flex shrink-0 items-center align-middle text-text-muted",
        className,
      )}
      title={desc.libelle}
    >
      <Glyphe glyphe={desc.glyphe} />
      <span className="sr-only">{desc.libelle}</span>
    </span>
  );
}
