# Plan — Enrichissement KPI « Analyse par catégorie » (camembert)

> Phase CONCEPTION (Règle 1). Fait suite au chantier camembert de base
> (`PLAN-graphiques-camembert.md`, branche `feat/graphiques-camembert`).
> Déclencheur : retour Etienne 2026-07-08 — la page est « maigre » sur la vraie
> donnée (un seul secteur « UNCLASSIFIED » à 100 %).

## Constat (grounded)

1. **Bug de libellé.** Sur la vraie donnée, `primary_category` vaut la sentinelle
   littérale Omni-FI `UNCLASSIFIED` (cf. schéma `transactions_cache` l.434
   « ayant abouti à "Uncategorized" » ; la doc API montre les vraies catégories en
   Title Case : « Utilities », « Banking & Finance »). Or `repartitionParCategorie`
   ne replie en « Non catégorisé » que `NULL`/`''` → la sentinelle brute anglaise
   fuit dans l'UI FR et monopolise le donut.
2. **Donut pauvre = donnée pauvre.** Quasiment rien n'est catégorisé côté Omni-FI
   pour ce workspace → un camembert ne peut pas être riche. On EXPOSE ce fait
   (KPI de couverture) au lieu de le masquer.

## Décisions

- **Libellé (choix Etienne : corriger le libellé seulement).** Étendre la détection
  du non-catégorisé aux sentinelles `UNCLASSIFIED`/`Uncategorized`
  (insensible casse + espaces). Préserver la casse des vraies catégories.
- **Variation calculée EN LOCAL**, pas via l'endpoint Omni-FI `CategoryAnomalies` :
  évite une nouvelle surface d'auth amont (Règle 3) pour un résultat d'affichage
  identique, et reste testable sous RLS.
- **Variation = 2e requête séparée**, PAS un `FILTER` conditionnel sur la requête
  principale : la requête courante (qui pilote tout le donut) reste INCHANGÉE, donc
  la feature « variation » ne peut pas casser les montants du camembert. Merge par
  clé `(devise, catégorie)` en JS = simple recopie d'une CHAÎNE SQL (aucune addition
  de montant en JS, règle 8).
- **Fenêtre précédente** = fenêtre contiguë de MÊME LONGUEUR (en jours) finissant la
  veille de `from`. Règle uniforme pour tous les presets, pure et testable
  (`bornesPeriodePrecedente`). Documentée comme baseline glissante (≠ mois calendaire).

## Garde-fous (non négociables)

- **Règle 8** : tout montant/moyenne = agrégat SQL en CHAÎNE décimale
  (`::numeric(15,2)::text`), jamais de float. Les ratios d'AFFICHAGE (%, concentration,
  delta %) passent par un `Number()` cul-de-sac (comme `pourcentPart`), qui ne
  réinjecte JAMAIS dans un montant.
- **Multi-devise** : jamais d'addition cross-devise. Totaux/moyennes via window
  `partition by currency`. Une carte par devise.
- **RLS** : `withWorkspace` + `innerJoin(bankAccounts)` (ENTITY-READ-JOIN1) sur les
  DEUX requêtes (courante + précédente).
- **Tokens UI** : aucune couleur en dur. Le badge de variation N'UTILISE PAS
  `inflow`/`outflow` (vert/rouge sémantiques réservés à la donnée montant) : flèches
  + `text-muted`/`text` neutres.

## Lots

- **L1 — Libellé non-catégorisé (repo).** `cleCategorie` = `CASE` détectant les
  sentinelles → NULL. Grouper/trier sur le `CASE`. Cas de test : `UNCLASSIFIED`
  collapse avec `NULL`/`''` dans un seul poste « Non catégorisé ».
- **L2 — Stats d'en-tête par devise.** `RepartitionDevise.montantMoyen` (SQL,
  total/nb). Composant `stats-devise` : montant moyen/opération, nombre de
  catégories (hors non-cat, compté en JS sur `parts`), % catégorisé (couverture,
  display depuis la part non-cat).
- **L3 — Poste dominant + concentration.** Présentation depuis `parts` triées :
  catégorie n°1 (hors non-cat) + part cumulée du top 3 (`Number` sur les fractions,
  display). Aucun changement repo.
- **L4 — Variation vs période précédente.** `bornesPeriodePrecedente` ; params repo
  `fromPrecedent`/`toPrecedent` optionnels ; 2e requête agrégée (devise, catégorie,
  `sum`) → Map → `PartCategorie.montantPrecedent`. Badge ▲/▼ delta % dans la légende.
- **L5 (DIFFÉRÉ) — Top sous-catégories par poste.** Le plus complexe (agrégat niché
  `row_number` + type `sousParts` + UI expand) ET le moins utile sur la donnée
  actuelle (tout non-catégorisé → aucune sous-catégorie). Raccroché à ce plan comme
  lot suivant, à implémenter + valider vitest sur machine native. Entrée TODOS.
- **L6 — Tests + gates.** Étendre `graphiques-repartition-isolation.test.ts`
  (sentinelle, montantMoyen, montantPrecedent/fenêtre précédente). Mettre à jour
  `/demo/graphiques-states`. `tsc` + `lint` verts. Commit + `vitest` sur le Mac
  d'Etienne (le hook pre-commit lance `npm test`, non exécutable dans le sandbox
  Linux — binding rolldown natif absent).

## Contrats de types (cible)

```ts
interface PartCategorie {
  categorie: string; estNonCategorise: boolean;
  montant: string; part: string; nbTransactions: number;
  montantPrecedent: string; // sum période préc. ("0.00" si absent) — L4
}
interface RepartitionDevise {
  currency: string; total: string; nbTransactions: number;
  montantMoyen: string;     // total/nb, SQL — L2
  parts: PartCategorie[];
}
interface RepartitionCategories {
  sens: SensFlux; from: string; to: string;
  fromPrecedent: string; toPrecedent: string; // L4 (info libellé)
  devises: RepartitionDevise[];
}
```
