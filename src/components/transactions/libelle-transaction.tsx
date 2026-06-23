/**
 * Libellé d'une transaction (marchand) avec REPLI élégant. Présentationnel PUR.
 *
 * Depuis la correction d'ingestion PROD-MERCHANT1 (commit b00e81c), `cleanLabel`
 * est hydraté depuis l'enrichissement Omni-FI ; quand il est RÉELLEMENT absent
 * (`null`), on n'affiche plus un libellé blanc mais un repli neutre non-PII.
 *
 * Le repli se DISTINGUE visuellement de la vraie donnée (exigence « fallback
 * élégant ») : `text-muted` + italique léger — il se lit comme un placeholder, pas
 * comme un marchand. Un vrai marchand reste en `text-text` plein. Le `bank_label_raw`
 * (PII) n'est JAMAIS le repli : on affiche un texte générique, jamais le brut bancaire.
 *
 * Tokens UNIQUEMENT (UI_GUIDELINES) : aucune couleur en dur. Aucune sémantique
 * inflow/outflow ici (réservée au montant) — un repli n'est ni une entrée ni une
 * sortie ni une erreur.
 */

/** Texte affiché quand aucun marchand propre n'est disponible (non-PII). */
export const LIBELLE_REPLI = "Opération bancaire";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function LibelleTransaction({
  cleanLabel,
  className,
}: {
  /** Marchand normalisé Omni-FI ; `null`/vide ⇒ repli. */
  cleanLabel: string | null | undefined;
  /** Classes de mise en page (troncature, taille) portées par l'appelant. */
  className?: string;
}) {
  const propre = cleanLabel?.trim();
  if (propre) {
    return <span className={cn("text-text", className)}>{propre}</span>;
  }
  return (
    <span
      className={cn("italic text-text-muted", className)}
      title="Libellé non communiqué par la banque"
    >
      {LIBELLE_REPLI}
    </span>
  );
}
