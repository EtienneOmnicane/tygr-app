# Cadrage — Page « Échéances » (Dodo)

> **Phase : CONCEPTION** (Règle 1). Aucune ligne de code applicatif tant que le
> périmètre v1 n'est pas validé et formalisé en plan d'implémentation. Ce
> document tranche le *quoi* et le *pourquoi* ; le *comment* (schéma détaillé,
> Server Actions, tests) suivra dans un plan d'implémentation dédié.
>
> Statut : **PROPOSÉ** — 2026-07-08. En attente d'arbitrage de scope (Etienne).
> Sources : `docs/cahier_des_charges.md` (Epics 4/5/6/8), `docs/UI_GUIDELINES.md`
> (§3.5, §3.6, §4.1), captures FYGR `docs/benchmarks/FYGR/3_deadlines/`.

---

## 1. Le problème à cadrer

L'onglet Échéances est **actif mais vide** (`(workspace)/echeances/page.tsx` =
Empty State « Suivez vos paiements à venir »). La dette `NAV-ECHEANCES1` (P2,
TODOS.md) le disait explicitement : *« Sujet MÉTIER, pas technique : prévisionnel ?
factures à venir ? rappels ? »*. Ce cadrage répond à cette question.

Le point-clé : **Échéances n'est pas une page isolée — c'est la source de saisie
du prévisionnel**. Sans elle, la partie droite (grisée, §3.5) de la nouvelle courbe
de solde cumulé du dashboard reste vide : on ne peut afficher que le réalisé. Les
échéances sont ce qui *peuple le futur* de la trésorerie.

---

## 2. Ce que les sources imposent déjà (pas un cadrage vierge)

Contrairement au cadrage Graphiques, l'écran n'est pas à inventer : trois sources
convergent et le contraignent fortement.

**Cahier des charges** — l'échéancier est spécifié sur plusieurs epics :
- **Epic 8 · FEAT-8.2 « Module Dettes & Échéanciers (saisie manuelle) »** — le
  cœur : le DAF saisit manuellement des engagements futurs (montant, date), qui
  *« génèrent des échéances projetées alimentant la courbe prévisionnelle (zone
  grisée, UI_GUIDELINES §3.5) »*. **Saisie manuelle au MVP**, explicitement.
- **Epic 4 · Moteur de Modélisation Prévisionnelle** — FEAT-4.1 (occurrences
  récurrentes) et FEAT-4.2 (TVA décalée auto-projetée). C'est le moteur de calcul
  *derrière* la matrice ; il déborde largement une v1.
- **Epic 6 · Comptabilité d'engagement & lettrage** — rapprochement facture ↔
  transaction réelle (`<SplitScreenReconciliation />`). Lourd, dépend d'un import
  de factures. Hors v1.
- **Epic 5 · What-If / variance** — scénarios optimiste/pessimiste. Hors v1.

**UI_GUIDELINES** — le design system anticipe déjà l'écran :
- **§3.6 Statuts d'échéances** : les badges sont *déjà normés* (`En cours`,
  `En retard`, `Partiel`, `Paiement en cours`, `Payée`, `Annulée` — pastel + texte
  700). Rien à inventer côté états.
- **§3.5 Prévisionnel vs Réalisé** + **§4.1 Matrice de flux** : le traitement
  visuel du futur (fond `surface-forecast`, séparateur « aujourd'hui », badge
  « Prévision ») est spécifié. La matrice §4.1 est la forme *cible long terme*,
  pas la v1.

**FYGR « Deadlines »** (`3_deadlines/`) — la forme éprouvée : onglets
**Customers / Suppliers**, table (N° facture, Échéance, Projection, Solde TTC,
Description, Catégorie, Statut), CTA « Add an invoice », panneau latéral
« Balance Today » + « Current Invoices » avec sélecteur d'horizon (30/45/60 j,
3/6/12 mois) ventilé Clients (↓) / Fournisseurs (↑) / Global, et un Empty State
« NO INVOICE ADDED ». **À retenir : la forme (liste dirigée + panneau de synthèse
par horizon). À écarter : le couplage « facture » (numéro, TTC, lettrage) qui est
de l'Epic 6.**

**État technique** : aucune table d'échéance/facture/dette n'existe (`schema.ts`
— on a `parties`, `categories`, mais rien de prévisionnel). C'est donc une
**surface de données neuve**.

---

## 3. Périmètre v1 recommandé (Règle 10 — je tranche, tu arbitres)

**Échéances v1 = Registre manuel d'échéances prévisionnelles.**

Un CRUD de mouvements futurs *planifiés* — pas des factures, pas du lettrage. Une
échéance = une intention de trésorerie datée :

> `{ libellé, sens (encaissement | décaissement), contrepartie (texte libre),
> montant + devise, date d'échéance, catégorie (optionnelle), statut, récurrence
> (optionnelle), entité (scope) }`

### 3.1 Ce que la v1 fait (IN)

1. **Saisie manuelle** (formulaire) d'une échéance à venir, avec les champs
   ci-dessus. C'est la brique FEAT-8.2. Sens = à encaisser (client) / à décaisser
   (fournisseur), calqué sur l'axe Customers/Suppliers de FYGR.
2. **Liste dirigée** — deux vues (à encaisser / à décaisser), colonnes : libellé,
   contrepartie, date d'échéance, montant (devise en préfixe, `tabular-nums`),
   catégorie, statut (badge §3.6). Tri par date d'échéance croissante. Édition /
   suppression / changement de statut inline.
3. **Panneau de synthèse par horizon** (reprise FYGR) : total à encaisser / à
   décaisser / net projeté sur 30 · 60 · 90 j, **par devise, jamais de somme
   cross-devise** (DASH-FX1, cf. cadrage Graphiques). Une échéance « en retard »
   (date passée, statut non `Payée`/`Annulée`) est remontée en tête avec badge
   `En retard`.
4. **4 états** (Loading / Empty / Error / rempli) selon la convention maison ;
   Empty State déjà en place, à enrichir avec le CTA « Ajouter une échéance ».
5. **Contrat de projection** (défini, pas encore branché) : chaque échéance non
   terminée expose un point de flux futur `{ date, sens, montant, devise, entité }`
   consommable par la zone prévisionnelle (grise) de la courbe de solde cumulé.

### 3.2 Ce que la v1 NE fait PAS (OUT — différé, nommé)

- **Branchement effectif dans la courbe du dashboard** → *séquencé après* le
  composant de courbe (décision « Composant d'abord » déjà actée). La v1 **définit
  et expose** le contrat de projection ; le câblage se fait quand la courbe de
  solde cumulé + les données EOD (`PROD-TRESO-EOD1`, `plan/treso-eod`) existent.
  Éviter de brancher sur une courbe qui n'est pas encore construite.
- **Lettrage / rapprochement facture ↔ transaction réelle** (Epic 6) → P2.
- **Import / notion de « facture »** (numéro, TTC, PDF) → P2. En v1 la contrepartie
  est un **texte libre**, pas un lien `parties` (pré-remplissage PartyId =
  `ENTITY-PARTY1`, déjà dette P2).
- **TVA décalée automatique** (FEAT-4.2) → P2.
- **Scénarios What-If / variance budget vs actual** (Epic 5) → P2.
- **Matrice de flux éditable §4.1** → c'est le *format long terme* du prévisionnel,
  gros build Epic 4 ; plus proche du dashboard/Graphiques que d'une v1 Échéances.
  La v1 est une **liste**, pas une matrice.
- **Alertes proactives** (FEAT-8.3) → P2.

### 3.3 Pourquoi cette découpe (et pas la matrice tout de suite)

La matrice §4.1 est séduisante mais c'est un piège de séquencement : elle suppose
le moteur d'occurrences (Epic 4.1), l'édition inline cellule par cellule, la TVA
décalée, et un rendu pivot complexe — avant même qu'une seule échéance existe en
base. La **liste + saisie** livre la valeur métier réelle (le DAF planifie ses
décaissements) avec une surface contenue, et **produit exactement la donnée** dont
la matrice ET la courbe auront besoin ensuite. On construit la source avant la
visualisation. La liste n'est jamais jetée : elle reste la vue « détail » à côté
de la matrice « agrégat ».

---

## 4. Décisions structurantes à trancher (avant implémentation)

| # | Décision | Recommandation | Enjeu |
|---|---|---|---|
| **ECH-D1** | Une échéance porte-t-elle un `entity_id` (scope) propre, ou hérite-t-elle via un compte bancaire cible ? | **`entity_id` propre, nullable** (comme `parties`). Le DAF planifie « Rs X du client Y » sans forcément connaître le compte. | Une échéance = **nouvelle surface tenant + entité**. RLS tenant (PERMISSIVE) + `entity_scope` (RESTRICTIVE) OBLIGATOIRES. Fuite = intra-groupe (grave). |
| **ECH-D2** | `date_echeance` : `DATE` ou `TIMESTAMPTZ` ? | **`DATE`** (jour calendaire d'exigibilité, pas un instant). Toute comparaison « en retard ? » se fait vs *aujourd'hui à `Indian/Mauritius`* (règle localisation). | Une échéance est due « le 15 juillet », pas « à 14h03 UTC ». Confondre = bug de bascule de jour. |
| **ECH-D3** | Table éditable/supprimable ou append-only ? | **Éditable + supprimable** (donnée utilisateur de projection, pas de l'historique réalisé). → **liste blanche DELETE** de `tygr_app.sql`. | Ne JAMAIS toucher `transactions_cache`/`balance_history` (append-only). L'échéance vit dans sa propre table normale. |
| **ECH-D4** | Récurrence en v1 ? | **Champ optionnel simple** (aucune / mensuelle / trimestrielle) matérialisé **à la génération de points de projection**, pas en dupliquant N lignes en base. Zéro moteur d'occurrences (Epic 4.1) au MVP. | Éviter de sur-construire ; garder la porte ouverte à FEAT-4.1. |
| **ECH-D5** | Statut : machine d'états ou champ libre ? | **Enum figé §3.6** (`en_cours`/`en_retard`/`partiel`/`paiement_en_cours`/`payee`/`annulee`). `en_retard` **dérivé** (date passée + non soldée), pas stocké. | Cohérence badges. Un statut dérivé ne se désynchronise pas. |
| **ECH-D6** | Devise & multi-devises | **1 échéance = 1 devise** ; synthèse **par devise**, jamais d'addition cross-devise (réutilise DASH-FX1). Montant = DECIMAL / chaîne, jamais float (règle 8). | Cohérent avec tout le reste de Dodo. |

Les décisions ECH-D1 et ECH-D3 touchent l'**isolation tenant/entité** : conformément
à la règle 9, ce ne sont **pas** des dettes différables — la RLS (tenant + entity)
et les tests d'isolation (IDOR cross-workspace → 404 ; fuite entité) sont
**livrés dans le même PR**, bloquants en CI.

---

## 5. Esquisse du modèle de données (à détailler en implémentation)

Table `echeances` (nom de plumbing en anglais, cohérent schema.ts), pattern calqué
sur `parties` / `categories` :

- `id` uuid PK ; `workspace_id` (tenant, FK `workspaces`) ; `entity_id` **nullable**
  (scope, FK **composite** `(entity_id, workspace_id) → entities(id, workspace_id)`,
  `ON DELETE RESTRICT`).
- `direction` enum (`encaissement` | `decaissement`).
- `libelle` varchar ; `contrepartie` varchar **nullable** (texte libre v1).
- `montant` DECIMAL (jamais float) ; `devise` char(3).
- `date_echeance` `DATE` (ECH-D2).
- `categorie_id` **nullable**, FK composite `(categorie_id, workspace_id) →
  categories(id, workspace_id)`.
- `statut` enum §3.6 (hors `en_retard`, dérivé — ECH-D5).
- `recurrence` enum nullable (`aucune`/`mensuelle`/`trimestrielle` — ECH-D4).
- `montant_regle` DECIMAL nullable (support du statut `partiel`).
- `created_by`, `created_at`, `updated_at` (timestamptz UTC).

Contraintes : `UNIQUE(id, workspace_id)` (cible de FK composites futures) ;
`index(workspace_id, entity_id)`, `index(workspace_id, date_echeance)` ; policies
`tenant_isolation` (PERMISSIVE) + `entity_scope` (RESTRICTIVE FOR ALL, USING +
WITH CHECK) via `app.current_entity_scope` — **exactement** le pattern
`bank_accounts`. Table dans la **liste blanche DELETE** de `tygr_app.sql`, jamais
un `GRANT … DELETE ON ALL TABLES`.

---

## 6. Surface applicative (Règle 3 — exit criteria par route/action)

- **Server Actions** : `creerEcheance`, `modifierEcheance`, `changerStatutEcheance`,
  `supprimerEcheance`, `listerEcheances(horizon)`. Toutes via `withWorkspace` ;
  ressource d'un autre tenant → **404, jamais 403**.
- **Validation zod stricte** (bornes montant, longueurs, enum sens/statut/devise,
  date plausible) ; rejet nommé.
- **Garde d'écriture entité** (ENTITY-WRITE-SCOPE1) : un membre scopé ne crée/déplace
  une échéance que dans son périmètre ; INSERT `entity_id=NULL` sous Vision Entité =
  refusé (fail-closed).
- **Erreurs nommées** (code machine → message UI mappé) ; catch-all interdit.
- **Tests** : chemin heureux + échec spécifique + limite ; **+ cas d'isolation
  IDOR/entité ajoutés à la suite bloquante**.
- **Logs structurés** corrélés `workspace_id` (+ `entity_id` si pertinent) ; jamais
  de PII/contrepartie brute en télémétrie.

---

## 7. Rendu (tokens & composants — pas de « gstack »)

- **Statuts** : badges §3.6 (composant badge réutilisable, tokens pastel).
- **Prévisionnel/retard** : traitement §3.5 pour toute valeur future ; jamais la
  couleur seule (fond/opacité + label).
- **Montants/dates** : `src/lib/format-montant.ts` et `format-date.ts` **uniquement**
  (source unique — interdit de reformater en local). Devise = préfixe symbolique
  + espace fine insécable, colonnes `tabular-nums nowrap` non tronquées.
- **États** : primitives `states/` existantes (`StateCard`, `EmptyState`) ; route
  de démo `src/app/demo/echeances-states/` pour le Visual QA (Gate 4), hors prod.
- **Layout** : liste dans le shell Dodo mergé (sidebar + topbar) ; panneau de
  synthèse à droite ou en tête selon breakpoint — **condenser**, jamais `flex-wrap`
  sur le header.

---

## 8. Séquencement proposé

1. **Ce plan validé** (scope v1 arbitré) → plan d'implémentation détaillé
   (schéma + migration + RLS + tests d'isolation) — nouvelle requête, phase
   conception→implémentation séparée (Règle 1).
2. **Lot données + RLS** : table `echeances`, migration, policies tenant+entité,
   provisioning (liste blanche DELETE), suite d'isolation bloquante.
3. **Lot Server Actions** : CRUD scopé + zod + erreurs nommées + tests.
4. **Lot UI** : liste dirigée + formulaire de saisie + panneau synthèse + 4 états
   + démo Visual QA.
5. **Différé (post-courbe)** : câblage du contrat de projection (§3.1.5) dans la
   zone grise de la courbe de solde cumulé, une fois le composant courbe +
   `PROD-TRESO-EOD1` livrés.

Correspond au point 4 d'Etienne (« coder la page échéance ») et rejoint le point 1
(la courbe) par le contrat de projection — sans créer de dépendance bloquante entre
les deux.

---

## 9. Ce sur quoi j'ai besoin d'un arbitrage

Une seule vraie question de scope : **la v1 « registre manuel » (liste + saisie +
synthèse par horizon) te convient-elle comme premier jet, en différant lettrage
(Epic 6), matrice §4.1 et What-If (Epic 5) ?** Si oui, je rédige le plan
d'implémentation. Les décisions ECH-D1→D6 ont une recommandation par défaut ;
dis-moi si l'une te gêne, sinon je les acte telles quelles.
