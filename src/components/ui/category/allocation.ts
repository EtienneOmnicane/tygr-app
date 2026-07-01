/**
 * Logique PURE d'allocation pour la ventilation (SplitAllocationModal, Pilier 1).
 * Zéro React, zéro réseau — toute la décision « où en est la ventilation » vit
 * ici, testable aux bornes (modèle machine-mfa). Réutilisable par la
 * réconciliation 1:N du pilier Échéances (même calcul de « reste »).
 *
 * Montants : chaînes décimales `numeric(15,2)` (règle 8, jamais de float). Tout
 * le calcul passe par des CENTIMES ENTIERS (BigInt) pour éviter l'imprécision
 * binaire (0.1 + 0.2 !== 0.3). On ne reconvertit en chaîne décimale qu'en sortie.
 *
 * NB : on utilise `BigInt(n)` et non les littéraux `0n`/`100n` — la cible
 * tsconfig est ES2017 (les littéraux BigInt exigeraient ES2020), le type bigint
 * reste disponible via `lib: esnext`.
 *
 * Formatage d'AFFICHAGE (milliers + espace fine + devise) : ce module n'en fait
 * PAS — il réutilise `formatMontant` de `@/lib/format-montant` (DRY). `allocation.ts`
 * ne fait QUE le calcul.
 */

const ZERO = BigInt(0);
const CENT = BigInt(100);

/** Montant max représentable : numeric(15,2) → 13 chiffres avant la virgule. */
const MAX_ENTIERS = 13;

/** Une ligne d'allocation en cours (montant = chaîne, éventuellement vide/partielle). */
export interface LigneAllocation {
  /** Identifiant local de ligne (clé React stable), pas l'id serveur du split. */
  cle: string;
  categoryId: string | null;
  /** Saisie brute de l'utilisateur (peut être "", "12", "12.5", "abc"…). */
  montantSaisi: string;
}

export interface EtatAllocation {
  /** Total alloué (somme des montants valides), chaîne décimale. */
  alloue: string;
  /** Reste = total − alloué (≥ 0 en cas normal ; négatif si dépassement). */
  reste: string;
  /** true si la somme allouée dépasse le montant total (état INVALIDE). */
  depasse: boolean;
  /** Ratio alloué/total dans [0, +∞[ (peut dépasser 1 si depasse). */
  ratio: number;
  /** true si au moins une ligne a un montant valide > 0. */
  aAuMoinsUneLigne: boolean;
}

/** Parse une chaîne décimale en centimes (BigInt). null si format invalide. */
export function enCentimes(montant: string): bigint | null {
  const v = montant.trim();
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(v)) return null;
  const [entier, decimal = ""] = v.split(".");
  const centimes = (decimal + "00").slice(0, 2);
  try {
    return BigInt(entier) * CENT + BigInt(centimes);
  } catch {
    return null;
  }
}

/** Formate des centimes (BigInt) en chaîne décimale "1234.50". */
export function depuisCentimes(centimes: bigint): string {
  const negatif = centimes < ZERO;
  const abs = negatif ? -centimes : centimes;
  const entiers = abs / CENT;
  const cents = abs % CENT;
  const txt = `${entiers}.${cents.toString().padStart(2, "0")}`;
  return negatif ? `-${txt}` : txt;
}

/** Un montant saisi est-il un format décimal valide (≤ 2 décimales, > 0) ? */
export function montantValide(montantSaisi: string): boolean {
  const c = enCentimes(montantSaisi);
  return c !== null && c > ZERO;
}

/**
 * Calcule l'état d'allocation à partir du montant total (|txn|) et des lignes
 * en cours. Ne tient compte QUE des lignes au montant valide > 0 (les lignes
 * vides ou en cours de saisie sont ignorées du total — elles ne bloquent rien).
 */
export function calculerAllocation(
  montantTotal: string,
  lignes: LigneAllocation[],
): EtatAllocation {
  const totalC = enCentimes(montantTotal) ?? ZERO;
  let alloueC = ZERO;
  let aAuMoinsUneLigne = false;
  for (const ligne of lignes) {
    const c = enCentimes(ligne.montantSaisi);
    if (c !== null && c > ZERO) {
      alloueC += c;
      aAuMoinsUneLigne = true;
    }
  }
  const resteC = totalC - alloueC;
  return {
    alloue: depuisCentimes(alloueC),
    reste: depuisCentimes(resteC),
    depasse: alloueC > totalC,
    ratio: totalC === ZERO ? 0 : Number(alloueC) / Number(totalC),
    aAuMoinsUneLigne,
  };
}

/**
 * Une ligne est-elle « la goutte » qui fait dépasser ? Sert à marquer le champ
 * fautif en `danger`. Vrai si la somme totale dépasse ET que retirer cette ligne
 * ramènerait dans le total.
 */
export function ligneEnDepassement(
  montantTotal: string,
  lignes: LigneAllocation[],
  cleLigne: string,
): boolean {
  const totalC = enCentimes(montantTotal) ?? ZERO;
  let sommeC = ZERO;
  for (const ligne of lignes) {
    const c = enCentimes(ligne.montantSaisi);
    if (c !== null && c > ZERO) sommeC += c;
  }
  if (sommeC <= totalC) return false;
  const courante = lignes.find((l) => l.cle === cleLigne);
  const cCourante = courante ? enCentimes(courante.montantSaisi) : null;
  if (cCourante === null || cCourante <= ZERO) return false;
  return sommeC - cCourante <= totalC;
}

/**
 * Ensemble des `cle` de lignes en DOUBLON de catégorie : une catégorie choisie
 * (non-null) sur ≥ 2 lignes marque TOUTES ses lignes (miroir de
 * `ligneEnDepassement`). Sert à peindre les champs fautifs en `danger` et à
 * bloquer « Valider » AVANT le rejet serveur (TX-QA-SPLIT-DOUBLON1). L'UI est un
 * confort : le repository reste la garde. Ne touche pas aux montants — la
 * détection porte sur `categoryId` (règle 8, aucun float). Les lignes sans
 * catégorie (null) ne comptent pas comme doublon (elles n'atteignent pas le
 * serveur — cf. versPayload).
 */
export function lignesEnDoublon(lignes: LigneAllocation[]): Set<string> {
  const compte = new Map<string, string[]>(); // categoryId -> [cle…]
  for (const ligne of lignes) {
    if (ligne.categoryId === null) continue;
    const cles = compte.get(ligne.categoryId) ?? [];
    cles.push(ligne.cle);
    compte.set(ligne.categoryId, cles);
  }
  const enDoublon = new Set<string>();
  for (const cles of compte.values()) {
    if (cles.length > 1) for (const c of cles) enDoublon.add(c);
  }
  return enDoublon;
}

/**
 * Peut-on valider (envoyer au serveur) ? Oui si : au moins une ligne valide,
 * AUCUN dépassement, AUCUN doublon de catégorie, et toute ligne « active »
 * (montant OU catégorie saisi) est COMPLÈTE (catégorie + montant valides). Le
 * PARTIEL est autorisé (somme < total).
 */
export function peutValider(
  montantTotal: string,
  lignes: LigneAllocation[],
): boolean {
  const etat = calculerAllocation(montantTotal, lignes);
  if (!etat.aAuMoinsUneLigne || etat.depasse) return false;
  // Doublon de catégorie interdit (l'UI n'amène jamais jusqu'au rejet serveur).
  if (lignesEnDoublon(lignes).size > 0) return false;
  for (const ligne of lignes) {
    const aMontant = ligne.montantSaisi.trim() !== "";
    const aCategorie = ligne.categoryId !== null;
    if (aMontant && (!montantValide(ligne.montantSaisi) || !aCategorie)) {
      return false; // montant saisi mais invalide ou sans catégorie
    }
    if (!aMontant && aCategorie) {
      return false; // catégorie choisie sans montant → incomplète
    }
  }
  return true;
}

/**
 * Construit la charge utile pour `remplacerSplitsAction` : ne garde que les
 * lignes complètes (catégorie + montant valide > 0), montant normalisé à 2
 * décimales. Les lignes vides/partielles sont écartées.
 */
export function versPayload(
  lignes: LigneAllocation[],
): Array<{ categoryId: string; amount: string }> {
  const out: Array<{ categoryId: string; amount: string }> = [];
  for (const ligne of lignes) {
    if (ligne.categoryId && montantValide(ligne.montantSaisi)) {
      const c = enCentimes(ligne.montantSaisi)!;
      out.push({ categoryId: ligne.categoryId, amount: depuisCentimes(c) });
    }
  }
  return out;
}

/** Limite dure : nombre max de splits accepté par le serveur (schéma .max(50)). */
export const MAX_SPLITS = 50;
export { MAX_ENTIERS };
