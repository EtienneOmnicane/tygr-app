/**
 * Groupement des comptes connectés par TITULAIRE (Omni-FI Party) — helper PUR
 * partagé par le bandeau « Comptes connectés » (accordéon dashboard, display-only),
 * l'onglet « Par compte » du sélecteur de périmètre, et le sélecteur de comptes de
 * /transactions (accordéon SÉLECTIONNABLE — PLAN-transactions-selecteur-entites.md, C2).
 *
 * Le titulaire est un LIBELLÉ de GROUPEMENT, jamais un filtre de sécurité : chaque
 * compte reçu ressort exactement une fois, aucun n'est masqué (conservation totale).
 * Le périmètre de sécurité vit dans la RLS, en amont (listerComptes) — ce qui rentre
 * ici est déjà scopé tenant + entité. Ce qu'un consommateur fait de la sélection
 * (filtre /transactions) reste borné côté serveur (DROIT ∩ filtre, règle 2).
 *
 * Zéro React, zéro dépendance : testable en isolation (tests/unit).
 */

/**
 * Contrat MINIMAL pour être groupable par titulaire : un porteur `holderId`
 * (clé de groupe) et un `holderName` (libellé). `bankAccountId` sert de clé de
 * rendu stable. Le groupement est GÉNÉRIQUE sur ce contrat (D3) : il sert le
 * dashboard (`CompteConnecte`, display-only) ET le sélecteur de /transactions
 * (`CompteFiltre` enrichi, sélectionnable) — le type serveur `CompteConnecte`
 * satisfait ce contrat sans y être couplé.
 */
export interface CompteTitulable {
  bankAccountId: string;
  holderId?: string | null;
  holderName?: string | null;
}

export interface GroupeTitulaire<T extends CompteTitulable = CompteTitulable> {
  /** parties.id — clé de groupe STABLE (désambiguïse deux titulaires homonymes). */
  holderId: string | null;
  /** parties.name — libellé affiché ; null UNIQUEMENT pour le bucket « Non regroupé ». */
  holderName: string | null;
  /** Comptes du groupe, dans l'ordre reçu (déjà triés par accountName en amont). */
  comptes: T[];
}

/** Tri des libellés titulaire en français (accents, casse). */
const collator = new Intl.Collator("fr");

/**
 * Libellés de titulaire GÉNÉRIQUES : placeholders amont qui ne portent aucune
 * identité réelle (`PartyName` par défaut d'Omni-FI en sandbox — 77/87 comptes
 * chez Etienne). Ils restent des groupes PROPRES (libellé + compteur + sélection)
 * mais sont RELÉGUÉS après les titulaires réellement nommés (S3), avant « Non
 * regroupé ». Comparaison sur nom normalisé (trim + minuscules fr).
 *
 * ⚠️ Sentinelle en dur — dette TITULAIRE-GENERIQUE1 (P2, TODOS.md) : à retirer
 * quand Omni-FI exposera un flag de placeholder OU quand la prod fournira de
 * vrais PartyName (le cas générique disparaît alors).
 */
const NOMS_TITULAIRE_GENERIQUES = new Set(["account holder"]);

function estTitulaireGenerique(holderName: string): boolean {
  return NOMS_TITULAIRE_GENERIQUES.has(
    holderName.trim().toLocaleLowerCase("fr"),
  );
}

/** Tri alpha fr des groupes nommés, homonymie départagée par holderId. */
function comparerGroupes(
  a: GroupeTitulaire<CompteTitulable>,
  b: GroupeTitulaire<CompteTitulable>,
): number {
  return (
    collator.compare(a.holderName ?? "", b.holderName ?? "") ||
    // Tiebreak homonymie par id : comparaison de code units (locale-indépendante,
    // les ids sont des UUID ASCII) — déterministe sur tout environnement ICU.
    ((a.holderId ?? "") < (b.holderId ?? "") ? -1 : 1)
  );
}

/**
 * Regroupe les comptes par titulaire. Contrat :
 * - conservation TOTALE : chaque compte apparaît exactement une fois (somme des
 *   groupes = entrée) ;
 * - clé de groupe = `holderId` (deux titulaires HOMONYMES restent deux groupes) ;
 * - un compte sans titulaire EXPLOITABLE (holderId null/absent, ou nom vide/blanc
 *   — jamais de « null » brut à l'écran, D7) tombe dans le bucket final
 *   `holderId: null` (« Non regroupé »), TOUJOURS en dernier ;
 * - ORDRE (S3) : titulaires réellement nommés (alpha fr) → titulaires GÉNÉRIQUES
 *   (« Account Holder », alpha fr) → bucket « Non regroupé ». L'égalité de nom
 *   est départagée par holderId (ordre déterministe) ;
 * - dans un groupe, l'ordre d'entrée des comptes est conservé.
 *
 * Le REPLI mono-groupe (< 2 groupes → liste plate, pas d'accordéon superflu) est
 * une décision de VUE : les consommateurs testent `groupes.length` (D4/D6).
 */
export function grouperParTitulaire<T extends CompteTitulable>(
  comptes: T[],
): GroupeTitulaire<T>[] {
  const parId = new Map<string, GroupeTitulaire<T>>();
  const sansTitulaire: T[] = [];

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

  const tous = [...parId.values()];
  const nommes = tous
    .filter((g) => !estTitulaireGenerique(g.holderName ?? ""))
    .sort(comparerGroupes);
  const generiques = tous
    .filter((g) => estTitulaireGenerique(g.holderName ?? ""))
    .sort(comparerGroupes);

  const groupes = [...nommes, ...generiques];
  if (sansTitulaire.length > 0) {
    groupes.push({ holderId: null, holderName: null, comptes: sansTitulaire });
  }
  return groupes;
}

/* ------------------------------------------------------------------ */
/* Sélection de groupe — DÉMÉNAGÉE vers lib/selection-groupe.ts        */
/* ------------------------------------------------------------------ */

/**
 * `etatSelectionGroupe` / `basculerGroupe` vivent désormais dans
 * `@/lib/selection-groupe` : elles ne dépendent que d'un `bankAccountId` et n'ont jamais
 * rien eu à voir avec les TITULAIRES. Les laisser ici obligeait l'écran d'assignation
 * d'ENTITÉS à importer un module de parties (dette de nommage, constat C2 de la
 * cross-review L3).
 *
 * Ré-export de compatibilité : `perimetre-switcher.tsx` et sa suite de tests continuent
 * d'importer depuis ce module sans changement. Le NOUVEAU code importe directement depuis
 * `@/lib/selection-groupe`.
 */
export {
  basculerGroupe,
  etatSelectionGroupe,
  type EtatSelectionGroupe,
  type SelectionnableParId,
} from "@/lib/selection-groupe";
