/**
 * Rangée KPI « Soldes par devise » (refonte Dodo — maquette Dodo.dc.html §Soldes
 * par devise). Remplace la carte SOLDE verticale du side-panel : les soldes
 * COURANTS s'affichent désormais en RANGÉE HORIZONTALE, une carte par devise
 * (grille `auto-fit minmax(200px)` → les cartes se répartissent et se replient
 * proprement selon la largeur).
 *
 * La carte de la DEVISE DE BASE du workspace est mise en avant (fond `ink`, carte
 * d'ancrage « trésorerie en 3 s ») ; les autres devises sont des cartes blanches.
 * Multi-devises (CLAUDE.md règle 8) : UNE LIGNE PAR DEVISE, jamais d'addition
 * cross-devise, aucune conversion FX d'affichage.
 *
 * Présentationnel PUR : reçoit les soldes (`soldesParDevise`) + les comptes (pour
 * le compteur « N comptes » par devise) et NE recalcule aucun montant. Formatage
 * via la source unique `format-montant` (indicateur + montant nu, zéro float —
 * règle 8) ; `tabular-nums` pour l'alignement (§0). Aucune couleur en dur : la
 * carte sombre étiquette en `primary-50` (bleu clair lisible sur `ink`).
 */
import type {
  CompteConnecte,
  SoldeParDevise,
} from "@/server/repositories/dashboard";

import {
  indicateurDevise,
  montantNu,
  nomDevise,
} from "@/lib/format-montant";
import { cn } from "@/components/ui/states/primitives";

export function SoldesDevisesRow({
  soldesParDevise,
  comptes,
  devise,
}: {
  /** Soldes consolidés courants, une entrée par devise (chaînes décimales). */
  soldesParDevise: SoldeParDevise[];
  /** Comptes visibles — servent UNIQUEMENT au compteur « N comptes » par devise. */
  comptes: CompteConnecte[];
  /** Devise de base du workspace : sa carte est mise en avant (fond ink). */
  devise: string;
}) {
  // Repli : aucun solde (aucun compte sélectionné) → une carte à 0 dans la devise
  // de base plutôt qu'une rangée vide.
  const lignes: SoldeParDevise[] =
    soldesParDevise.length > 0
      ? soldesParDevise
      : [{ currency: devise, total: "0" }];

  // Compteur de comptes par devise (le libellé « N comptes » de chaque carte).
  const nbParDevise = new Map<string, number>();
  for (const c of comptes) {
    nbParDevise.set(c.currency, (nbParDevise.get(c.currency) ?? 0) + 1);
  }

  // Devise de base en TÊTE (carte d'ancrage sombre), le reste dans l'ordre serveur.
  const base = lignes.find((l) => l.currency === devise);
  const reste = lignes.filter((l) => l.currency !== devise);
  const ordonnees = base ? [base, ...reste] : lignes;

  return (
    <div
      className="grid gap-3.5"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}
    >
      {ordonnees.map((ligne, i) => (
        <CarteSolde
          key={ligne.currency}
          ligne={ligne}
          nbComptes={nbParDevise.get(ligne.currency) ?? 0}
          actif={i === 0}
        />
      ))}
    </div>
  );
}

/**
 * Carte d'une devise. `actif` (devise de base) → fond `ink`, étiquettes `primary-50`.
 * Sinon carte blanche standard (bord `line`). Le montant est aligné à DROITE, jamais
 * tronqué (chiffre clé — règle de formatage figée) : `whitespace-nowrap tabular-nums`.
 */
function CarteSolde({
  ligne,
  nbComptes,
  actif,
}: {
  ligne: SoldeParDevise;
  nbComptes: number;
  actif: boolean;
}) {
  const indicateur = indicateurDevise(ligne.currency);
  return (
    <div
      className={cn(
        "rounded-card p-5",
        actif
          ? "bg-ink text-text-onink"
          : "border border-line bg-surface-card shadow-card",
      )}
    >
      <div
        className={cn(
          "text-[11px] font-semibold uppercase tracking-[0.08em]",
          actif ? "text-primary-50" : "text-text-muted",
        )}
      >
        {nomDevise(ligne.currency)}
      </div>
      <div
        className={cn(
          "mt-3.5 whitespace-nowrap text-right text-xl font-semibold leading-tight tabular-nums",
          actif ? "text-text-onink" : "text-text",
        )}
      >
        {indicateur && (
          <span
            className={cn(
              "mr-0.5 text-[13px] font-semibold",
              actif ? "text-primary-50" : "text-text-faint",
            )}
          >
            {indicateur}
          </span>
        )}
        {montantNu(ligne.total)}
      </div>
      <div
        className={cn(
          "mt-1 text-right text-xs tabular-nums",
          actif ? "text-primary-50" : "text-text-faint",
        )}
      >
        {nbComptes} compte{nbComptes > 1 ? "s" : ""}
      </div>
    </div>
  );
}
