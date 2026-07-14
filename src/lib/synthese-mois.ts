/**
 * Repli d'affichage pour la synthèse mensuelle VENTILÉE PAR DEVISE
 * (`synthesePeriodeParDevise`). Source UNIQUE consommée par `CashFlowSummary`
 * (pas de duplication de la règle de repli — règle 6/9).
 *
 * Le service renvoie une ligne par devise présente sur le mois, et un TABLEAU VIDE
 * quand le mois n'a aucune transaction. L'UI ne doit jamais montrer une carte vide :
 * dans ce cas on affiche un bloc à 0 dans la `devise` de base. On ne fabrique JAMAIS
 * de 0 cross-devise ni de conversion FX (CLAUDE.md règle 8 / DASH-FX1) : le repli est
 * un SEUL bloc, dans la devise de base, uniquement quand il n'y a STRICTEMENT rien.
 *
 * Tri stable par code devise (affichage déterministe, comme les soldes par devise).
 */
import type { SynthesePeriodeDevise } from "@/server/repositories/dashboard";

export function replierSynthesesMois(
  synthesesMois: SynthesePeriodeDevise[],
  deviseBase: string,
): SynthesePeriodeDevise[] {
  if (synthesesMois.length === 0) {
    return [{ currency: deviseBase, entrees: "0", sorties: "0", variation: "0" }];
  }
  // Copie triée (ne mute pas l'entrée) — ordre stable par devise.
  return [...synthesesMois].sort((a, b) => a.currency.localeCompare(b.currency));
}
