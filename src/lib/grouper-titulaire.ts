/**
 * Groupement des comptes connectés par TITULAIRE (Omni-FI Party) — helper PUR
 * partagé par le bandeau « Comptes connectés » (accordéon) et l'onglet « Par
 * compte » du sélecteur de périmètre (PLAN-bandeau-titulaire-accordeon.md, D3).
 *
 * DISPLAY-ONLY (règle 2) : le titulaire est un LIBELLÉ de présentation, jamais un
 * filtre — chaque compte reçu ressort exactement une fois, aucun n'est masqué.
 * Le périmètre de sécurité vit dans la RLS, en amont (listerComptes).
 *
 * Zéro React, zéro dépendance : testable en isolation (tests/unit).
 */
import type { CompteConnecte } from "@/server/repositories/dashboard";

export interface GroupeTitulaire {
  /** parties.id — clé de groupe STABLE (désambiguïse deux titulaires homonymes). */
  holderId: string | null;
  /** parties.name — libellé affiché ; null UNIQUEMENT pour le bucket « Non regroupé ». */
  holderName: string | null;
  /** Comptes du groupe, dans l'ordre reçu (déjà triés par accountName en amont). */
  comptes: CompteConnecte[];
}

/** Tri des libellés titulaire en français (accents, casse). */
const collator = new Intl.Collator("fr");

/**
 * Regroupe les comptes par titulaire. Contrat :
 * - conservation TOTALE : chaque compte apparaît exactement une fois (somme des
 *   groupes = entrée) ;
 * - clé de groupe = `holderId` (deux titulaires HOMONYMES restent deux groupes) ;
 * - un compte sans titulaire EXPLOITABLE (holderId null/absent, ou nom vide/blanc
 *   — jamais de « null » brut à l'écran, D7) tombe dans le bucket final
 *   `holderId: null` (« Non regroupé »), TOUJOURS en dernier ;
 * - groupes triés par nom (locale fr), égalité de nom départagée par holderId
 *   (ordre déterministe) ;
 * - dans un groupe, l'ordre d'entrée des comptes est conservé.
 *
 * Le REPLI mono-groupe (< 2 groupes → liste plate, pas d'accordéon superflu) est
 * une décision de VUE : les consommateurs testent `groupes.length` (D4/D6).
 */
export function grouperParTitulaire(
  comptes: CompteConnecte[],
): GroupeTitulaire[] {
  const parId = new Map<string, GroupeTitulaire>();
  const sansTitulaire: CompteConnecte[] = [];

  for (const compte of comptes) {
    const holderId = compte.holderId ?? null;
    const holderName = compte.holderName?.trim() || null;
    // Exploitable = id ET nom présents : un id sans nom n'a rien d'affichable
    // (D7 — pas de « null » brut), il rejoint « Non regroupé ».
    if (holderId === null || holderName === null) {
      sansTitulaire.push(compte);
      continue;
    }
    const groupe = parId.get(holderId);
    if (groupe) groupe.comptes.push(compte);
    else parId.set(holderId, { holderId, holderName, comptes: [compte] });
  }

  const groupes = [...parId.values()].sort(
    (a, b) =>
      collator.compare(a.holderName ?? "", b.holderName ?? "") ||
      (a.holderId ?? "").localeCompare(b.holderId ?? ""),
  );
  if (sansTitulaire.length > 0) {
    groupes.push({ holderId: null, holderName: null, comptes: sansTitulaire });
  }
  return groupes;
}
