/**
 * Page « Transactions » — liste réelle des opérations + ventilation (Pilier 1).
 *
 * Le chrome vient de `(workspace)/layout.tsx`. La 1re page de données arrive en RSC
 * (Suspense natif → `loading.tsx`), puis le conteneur CLIENT `TransactionsFeature`
 * gère filtres / pagination / ouverture de la SplitAllocationModal.
 *
 * CÂBLAGE FINAL (2026-06-17) : les Server Actions Backend sont livrées et branchées —
 *   - `listerTransactionsAction` (lecture paginée par curseur + résumé ventilation),
 *   - `listerSplitsAction` (détail des splits à l'ouverture de la modale ; LÈVE une
 *     exception en cas d'échec plutôt que de renvoyer [] → la modale ne s'ouvre pas
 *     sur un état faussement vide qui écraserait les splits au Valider),
 *   - `remplacerSplitsAction` (écriture atomique).
 * La réconciliation des contrats Backend↔UI vit dans `./adapter` (statut, compteNom,
 * curseur opaque, libellé non-PII). La 1re page est chargée ICI (RSC) ; le conteneur
 * recharge/paginera côté client via les mêmes actions.
 *
 * PÉRIODE (TX-TOOLBAR-DEDUP1) : la fenêtre de dates vient de la barre de vue GLOBALE
 * (`?periode`/`?du`/`?au`), plus des dates in-page. On lit `searchParams` et on résout
 * les bornes via `resoudrePeriode` (source unique, fuseau Maurice) — MÊME pattern que le
 * Dashboard — puis on les injecte côté serveur dans la 1re page, la pagination et la
 * somme. Le conteneur client REMONTE sur changement de période (prop `key`).
 *
 * Authz (règle 3) : exigerSessionWorkspace + withWorkspace. Mapping erreurs :
 * non auth → /login ; aucun workspace → /selection.
 */
import { redirect } from "next/navigation";

import { listerComptes, withWorkspace } from "@/server/db";
import {
  AucunWorkspaceActifError,
  exigerSessionWorkspace,
  NonAuthentifieError,
} from "@/server/auth/session";
import { peutAdministrer } from "@/lib/permissions";
import { resoudrePeriode } from "@/lib/periode";

import { TransactionsFeature } from "@/components/transactions";
import type {
  ActionsTransactions,
  PageTransactions,
} from "@/components/transactions/types-transactions";
import type {
  ActionsReferentielCategories,
  CategorieUI,
  ResultatAction,
  SplitUI,
} from "@/components/ui/category";

import {
  archiverCategorieAction,
  creerCategorieAction,
  importerCategoriesStandardAction,
  listerCategoriesAction,
  listerSplitsAction,
  listerTransactionsAction,
  remplacerSplitsAction,
  renommerCategorieAction,
  sommeNetteTransactionsAction,
} from "./actions";
import {
  versFiltresSommeNette,
  versInputBackend,
  versPageUI,
  versSommeNetteUI,
} from "./adapter";

export const metadata = { title: "Transactions — Dodo" };

export default async function PageTransactions({
  searchParams,
}: {
  // Next 16 : `searchParams` est un Promise à `await` (AGENTS.md « This is NOT the
  // Next.js you know »). Le lire opte la page en rendu dynamique — sans impact (la page
  // fetch déjà par requête sous withWorkspace, jamais prérendue).
  searchParams: Promise<{ [cle: string]: string | string[] | undefined }>;
}) {
  let session;
  try {
    session = await exigerSessionWorkspace();
  } catch (erreur) {
    if (erreur instanceof NonAuthentifieError) {
      redirect("/login");
    }
    if (erreur instanceof AucunWorkspaceActifError) {
      redirect("/selection");
    }
    throw erreur;
  }

  // Fenêtre de dates = barre de vue GLOBALE (TX-TOOLBAR-DEDUP1). On passe les searchParams
  // ENTIERS — `?periode` (preset) ET `?du`/`?au` (plage explicite, qui PRIME). On ne garde
  // que `from`/`to` (bornes au JOUR Maurice, INCLUSIVES) : la liste n'a pas de tendance à
  // ancrer, contrairement au Dashboard. Toute valeur d'URL invalide est NORMALISÉE par
  // `resoudrePeriode` (source unique) — l'URL brute ne touche jamais le SQL. URL propre
  // (aucun param) ⇒ preset par défaut « 6m ».
  const { from, to } = resoudrePeriode(await searchParams);
  const periode = { from, to };

  // Données serveur : catégories (modale), comptes (filtre + résolution compteNom),
  // rôle (gating UI du CTA d'import — la garde de fond reste serveur). Comptes +
  // rôle en UN SEUL withWorkspace (le rôle est re-résolu dans le même contexte).
  const [categoriesDTO, { comptes, role }] = await Promise.all([
    listerCategoriesAction(),
    withWorkspace(session, async (tx, ctx) => ({
      comptes: await listerComptes(tx),
      role: ctx.role,
    })),
  ]);

  const categories: CategorieUI[] = categoriesDTO.map((c) => ({
    id: c.id,
    name: c.name,
    parentId: c.parentId,
    isActive: c.isActive,
  }));

  // Nom affiché du compte porteur DANS LA TABLE : on privilégie le NOM DE BANQUE
  // (`institutionName`, déjà fourni par `listerComptes` via la connexion) plutôt
  // que le libellé interne `accountName` (souvent générique, « Main Operating
  // Account » à l'identique sur tous les comptes). Repli sur `accountName` si la
  // banque est inconnue, pour ne jamais afficher de vide.
  const nomCompte = (c: (typeof comptes)[number]) =>
    c.institutionName ?? c.accountName;
  // Le périmètre de comptes est piloté par le `PerimetreSwitcher` de la navbar
  // (scope serveur via withWorkspace/RLS) — la toolbar transactions ne porte plus de
  // sélecteur de compte (retrait feedback 0709 : doublon du sélecteur navbar). On ne
  // garde donc que `nomParCompte`, nécessaire à l'affichage du compte porteur en table.
  const nomParCompte = new Map(
    comptes.map((c) => [c.bankAccountId, nomCompte(c)]),
  );
  const aucuneBanque = comptes.length === 0;

  // Surface d'actions RÉELLE injectée au conteneur. Les closures pontent l'UI vers
  // les Server Actions Backend en passant par l'adaptateur de contrat. La résolution
  // de compteNom réutilise la map des comptes côté serveur (pas de requête en plus).
  const actionsTransactions: ActionsTransactions = {
    async listerTransactions({ curseur, filtres }) {
      "use server";
      // Capture `periode` (objet de 2 chaînes, SÉRIALISABLE — sans rapport avec le piège
      // « capture de fonction locale ») → chaque page reste bornée à la fenêtre globale,
      // pagination « Charger plus » comprise (sinon la page 2 ramènerait tout l'historique).
      const res = await listerTransactionsAction(
        versInputBackend(filtres, curseur, periode),
      );
      if (!res.ok) return res;
      return { ok: true, data: versPageUI(res.data, nomParCompte) };
    },
    async chargerSplits(ref): Promise<SplitUI[]> {
      "use server";
      // listerSplitsAction LÈVE en cas d'échec (jamais [] faussement vide) — le
      // conteneur catche et bloque l'ouverture de la modale (anti-écrasement).
      return listerSplitsAction(ref);
    },
    // TOTAL des résultats filtrés (TX-RECHERCHE-SOMME-NETTE1) : agrégat SERVEUR (SUM en
    // SQL sous RLS) portant les MÊMES filtres que la liste, mais SANS curseur — il
    // totalise TOUT le jeu filtré, pas la page affichée (piège TX-FILTRE1 : sommer côté
    // client ne verrait que le visible). `versFiltresSommeNette` dérive la projection de
    // filtres de `versInputBackend` (source unique) en retirant curseur/limite.
    async sommeNette({ filtres }) {
      "use server";
      const res = await sommeNetteTransactionsAction(
        versFiltresSommeNette(filtres, periode),
      );
      if (!res.ok) return res;
      return { ok: true, data: versSommeNetteUI(res.data) };
    },
  };

  // Première page (RSC) — rendue immédiatement, puis paginée/filtrée côté client. Bornée
  // à la fenêtre GLOBALE (`periode`) dès le premier rendu (pas de filtre in-page ici).
  const premiere = await listerTransactionsAction(
    versInputBackend(undefined, null, periode),
  );
  const initial: PageTransactions = premiere.ok
    ? versPageUI(premiere.data, nomParCompte)
    : { lignes: [], curseurSuivant: null };

  // Création rapide depuis le picker : une catégorie créée ainsi est une Nature
  // (parentId null). Adapte la signature `(name) → action({name, parentId})`.
  async function creerCategorieNature(name: string) {
    "use server";
    return creerCategorieAction({ name, parentId: null });
  }

  // CTA d'onboarding « Importer les catégories standard » (QA-ONBOARD-CATEG1) :
  // seed du référentiel depuis le picker vide. Adapte le DTO serveur au contrat UI
  // (CategorieUI). Réservé ADMIN — la closure n'est passée QUE si peutAdministrer
  // (règle D2 : surface admin ABSENTE du DOM pour un non-admin, pas juste grisée) ;
  // la garde de fond (repository) reste souveraine dans tous les cas.
  async function importerCategoriesStandard(): Promise<
    ResultatAction<{ imported: number; categories: CategorieUI[] }>
  > {
    "use server";
    const res = await importerCategoriesStandardAction();
    if (!res.ok) return res;
    return {
      ok: true,
      data: {
        imported: res.data.imported,
        categories: res.data.categories.map((c) => ({
          id: c.id,
          name: c.name,
          parentId: c.parentId,
          isActive: c.isActive,
        })),
      },
    };
  }

  // Surface d'actions du RÉFÉRENTIEL de catégories (gestionnaire : créer / renommer /
  // archiver / lister). Réservée ADMIN — on ne construit et ne passe l'objet QUE si
  // peutAdministrer(role) (surface ABSENTE du DOM pour un non-admin, règle D2). La
  // garde de fond reste le repository (exigerAdminReferentiel), souveraine dans tous
  // les cas. Chaque closure adapte le DTO serveur au contrat UI (CategorieUI).
  const actionsReferentiel: ActionsReferentielCategories = {
    async listerCategories(): Promise<CategorieUI[]> {
      "use server";
      // Transformation DTO→UI INLINE : une closure "use server" ne peut pas capturer
      // une fonction locale non-sérialisable (ex. un ancien `versUI` partagé) — Next
      // la refuse au rendu (« Functions cannot be passed directly to Client
      // Components »). On mappe donc ici, sans dépendance à une closure parente.
      return (await listerCategoriesAction()).map((c) => ({
        id: c.id,
        name: c.name,
        parentId: c.parentId,
        isActive: c.isActive,
      }));
    },
    async creerCategorie(input) {
      "use server";
      return creerCategorieAction(input);
    },
    async renommerCategorie(input) {
      "use server";
      return renommerCategorieAction(input);
    },
    async archiverCategorie(categoryId) {
      "use server";
      return archiverCategorieAction(categoryId);
    },
  };

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-text">Transactions</h1>
        <p className="mt-1 text-sm text-text-muted">
          Parcourez, filtrez et catégorisez vos opérations. Cliquez une ligne pour
          ventiler son montant.
        </p>
      </div>

      <TransactionsFeature
        // Identité de la fenêtre GLOBALE : quand la période change (barre de vue →
        // nouvelle URL → RSC re-rendu avec un `initial` frais), la `key` change et le
        // conteneur CLIENT REMONTE, re-seedant sa liste depuis la page 1 de la nouvelle
        // période. Sans ça, `TransactionsFeature` garde son `useState(initial)` d'origine
        // (état dérivé des props, jamais re-synchronisé) → la liste resterait PÉRIMÉE
        // jusqu'au prochain filtre in-page. (Corollaire assumé : les filtres in-page
        // recherche/statut se réinitialisent au changement de période — sémantique
        // « refresh complet » du Dashboard.)
        key={`${from}|${to}`}
        initial={initial}
        categories={categories}
        actions={actionsTransactions}
        remplacerSplits={remplacerSplitsAction}
        creerCategorie={creerCategorieNature}
        importerCategoriesStandard={
          peutAdministrer(role) ? importerCategoriesStandard : undefined
        }
        actionsReferentiel={
          peutAdministrer(role) ? actionsReferentiel : undefined
        }
        aucuneBanque={aucuneBanque}
      />
    </main>
  );
}
