# PLAN — PROD-MERCHANT-1 · Fiabiliser les libellés marchands (« Opération bancaire » résiduel)

> **Phase** : CONCEPTION uniquement (CLAUDE.md règle 1). Ce document est un plan sur
> disque. **Aucune ligne de code applicatif n'a été écrite.** L'implémentation est un
> fil séparé qui référencera ce plan.
> **Branche** : `plan/prod-merchant-1`.
> **Date de cadrage** : 2026-07-23.
> **Documents de référence** : `CONSTAT-qualite-libelles-omnifi.md` (diagnostic déjà
> mené sur données réelles), `OMNIFI_API_FEEDBACK.md`, mémoire
> `contrat-enrichment-imbrique`, `docs/documentation_api.md`.

---

## 0. Constat de cadrage — pushback règle 10 (à lire AVANT tout le reste)

Le brief pose comme **cause racine probable** : « `types.ts` lit les champs marchand À
PLAT, or Omni-FI les imbrique sous `Enrichment{}` → `t.CleanMerchantName` toujours
`undefined` → 100 % de fallback ».

**Cette prémisse est PÉRIMÉE. Le correctif de lecture flat→`Enrichment{}` est déjà en
production** (chantier PROD-MERCHANT1, cf. §3 pour la preuve dans le code courant). Écrire
un plan pour « re-corriger » ce bug reviendrait à rediagnostiquer comme ouvert un défaut
fermé depuis ~un mois — exactement le piège consigné en mémoire (`contrat-enrichment-imbrique` :
« CE BUG EST RÉSOLU ET MERGÉ SUR main — ne pas le rediagnostiquer comme ouvert »).

**Ce que le résidu « Opération bancaire » EST réellement** (diagnostic `CONSTAT-qualite-libelles-omnifi.md`,
mené sur la donnée déjà ingérée, compte réel) : une **limite de modélisation AMONT**, pas un
défaut d'ingestion TYGR. Chiffres clés :

- **~30 % des volumes** (≈ 3 027 transactions) s'affichent en **libellé brut** parce que
  l'amont **n'extrait pas de marchand** sur les narratifs longs — `Enrichment.CleanMerchantName`
  y est vide (chaîne `""` → `null` après `chaineOuNull`, comportement correct).
- **93,3 %** des transactions arrivent en `PrimaryCategory: UNCLASSIFIED` → le niveau 2 de la
  cascade (catégorie FR) est presque toujours inactif.
- **Aucun champ de contrepartie structuré** (`MerchantDetails` / `CreditorName` / `DebtorName`)
  n'existe dans le contrat API : tout nom de contrepartie doit être **deviné du texte libre**.
- Le mapping TYGR est **conforme au contrat réellement servi** (CONSTAT §4.1). « La pauvreté
  n'est pas un défaut d'ingestion de notre côté. »

**Conséquence sur le périmètre de ce chantier.** Il n'y a **pas de correctif de lecture à
écrire**. Le travail TYGR réellement actionnable et de forte valeur est :

| # | Lot | Nature | Valeur |
|---|-----|--------|--------|
| **V** | Vérification live sans PII (règle 6) | Sonde read-only, gating | Confirme que rien n'a régressé + quantifie « absence réelle » vs « lignes périmées » |
| **S** | Durcissement du bord amont : **validation zod du payload** | Correctif durable | Empêche la RÉCIDIVE d'un « 100 % fallback silencieux » (dé-imbrication, renommage amont) → échec BRUYANT au lieu de muet |
| **D** | Rétro-remplissage des lignes déjà ingérées | Opération de données (append-only) | Répare les lignes ingérées AVANT le fix (si elles existent), dans la fenêtre 92 j amont |
| **H** | (Optionnel) Heuristique d'extraction marchand + `BankTransactionCode` | Amélioration qualité | Récupère une partie des ~30 % en libellé brut — **décision ouverte** |
| **U** | Demande d'évolution AMONT | Non-code (canal Omni-FI) | Seul levier sur le fond (~30 % du volume) — déjà rédigée dans le CONSTAT |

Le cœur livrable de PROD-MERCHANT-1 = **V + S + D**. H et U sont des décisions ouvertes (§9).

---

## 1. Étape 0 — OBLIGATOIRE et GATING (règle 6) : sonde d'un payload réel SANS PII

> **Rien de ce qui suit (S, D) ne se décide sans cette étape.** Le CONSTAT a été mené sur
> la **donnée déjà ingérée**, pas sur un payload live — il note lui-même « aucune vérification
> live contre l'API amont ». Cette sonde comble ce trou et **tranche entre les hypothèses A/B**
> (§2.3). Sans elle, on planifie à l'aveugle.

### 1.1 Objectif

Confirmer, sur un payload **actuellement servi par l'API** (env sandbox `api-stage`, ou prod
si autorisée), **la STRUCTURE** de la transaction et **le taux de vacuité** de l'enrichissement —
**sans jamais journaliser la moindre valeur de libellé** (le narratif et le marchand sont de la
donnée bancaire, règle 8).

### 1.2 Protocole (read-only, à décrire — NON exécuté en phase conception)

Réutiliser le patron des scripts de diagnostic du CONSTAT (`node --env-file=.env <script>`,
`BEGIN TRANSACTION READ ONLY`, hors dépôt, dans `tygr-app/`). Le script appelle
`client.transactionsParCompte(...)` sur **un** compte et, pour chaque transaction, n'émet que
des **métadonnées structurelles** :

```
Pour chaque tx :
  "Enrichment" in tx                → bool          (imbrication présente ?)
  typeof tx.Enrichment              → "object"|…    (forme)
  Object.keys(tx.Enrichment ?? {})  → liste de CLÉS (jamais les valeurs)
  Pour chaque clé d'Enrichment :
    value === ""  → "EMPTY"
    value == null → "NULL"
    sinon         → "PRESENT"      ← JAMAIS la valeur elle-même
  "CleanMerchantName" in tx         → bool          (contre-preuve : à plat ?)
  tx.TransactionInformation présent → "PRESENT"|"EMPTY"|"NULL"  (jamais la valeur)
```

Agréger en compteurs : `% tx avec Enrichment objet`, `% CleanMerchantName PRESENT / EMPTY /
absent`, `% TransactionInformation PRESENT`, `% PrimaryCategory === "UNCLASSIFIED"`.

**Interdits stricts (règle 8)** : ne jamais logger `CleanMerchantName`, `TransactionInformation`,
`SubCategory`, `RuleIdMatch`, ni un `TransactionId` en clair dans un canal partagé. Seuls des
**agrégats** et des **drapeaux PRESENT/EMPTY/NULL** sortent. Le transport de `TransactionId`
précis à Omni-FI (pour repro) passe par un canal dédié, jamais collé dans un doc/log.

### 1.3 Ce que la sonde décide (portes de décision)

| Observation live | Conclusion | Action déclenchée |
|---|---|---|
| `Enrichment` **absent** ou **à plat** (`"CleanMerchantName" in tx` = true) | RÉGRESSION amont du contrat | STOP + escalade + zod (S) devient P0 |
| `Enrichment` objet, `CleanMerchantName` **EMPTY** massif | Absence RÉELLE amont (hypothèse A) | Fallback légitime → pas de correctif lecture ; lot H/U |
| `CleanMerchantName` **PRESENT** live mais `clean_label` **NULL en base** sur la même tx | Bug persist OU lignes périmées (hypothèse B) | Lot D (rétro-remplissage) devient nécessaire |
| Structure conforme, vacuité cohérente avec le CONSTAT | Diagnostic confirmé, rien de neuf | On exécute S + D tels que planifiés |

**Livrable de l'étape 0** : un court addendum chiffré à ce plan (ou au CONSTAT), sans PII,
qui verrouille l'hypothèse dominante avant d'écrire la moindre ligne.

---

## 2. Diagnostic confirmé (état RÉEL du code + données)

### 2.1 Chaîne de mapping actuelle (file:line VÉRIFIÉS le 2026-07-23)

> ⚠️ Les file:line du brief sont **décalés** (schema.ts:372-373 = `bank_accounts`, pas
> `clean_label` ; `transactions-table.tsx` n'existe pas au chemin cité ;
> `traduireCategorieBanque` est en `adapter.ts:240`, pas `:130`). Références corrigées :

| Champ TYGR | Champ API Omni-FI | Emplacement API | Lecture (code) |
|---|---|---|---|
| `bank_label_raw` | `TransactionInformation` | **racine** de la transaction | `orchestrateur.ts:139` (`chaineOuNull(t.TransactionInformation)`) |
| `clean_label` | `CleanMerchantName` | **imbriqué `Enrichment{}`** | `orchestrateur.ts:140` (`chaineOuNull(e?.CleanMerchantName)`) |
| `primary_category` | `PrimaryCategory` | imbriqué `Enrichment{}` | `orchestrateur.ts:146` (conditionné à `categorieAutoValide`) |
| `confidence_level` / `classification_source` / `rule_id_match` | idem | imbriqué `Enrichment{}` | `orchestrateur.ts:150-152` |

- Type amont : interface **`OmniFiEnrichment`** (`types.ts` ~L96-103) + champ `Enrichment?`
  (`types.ts` ~L127) ; le commentaire y qualifie explicitement les anciens champs à plat de
  « jamais émis par l'API ; cause du fallback "Opération bancaire", PROD-MERCHANT1 ».
- Colonnes : `clean_label varchar(255)` (`schema.ts:435`), `primary_category varchar(120)`
  (`schema.ts:437`), `bank_label_raw text` nullable (`schema.ts:434`).

### 2.2 Cascade d'AFFICHAGE (là où « Opération bancaire » naît vraiment)

Fonction pure `resoudreLibelle` (`src/components/transactions/libelle-transaction.tsx:84-103`),
constante `LIBELLE_REPLI = "Opération bancaire"` (`:40`). Hiérarchie (arbitrage produit
2026-06-23) :

1. `cleanLabel` (marchand enrichi) → texte plein — **niveau 1**.
2. sinon `categorieFr` (catégorie OBIE traduite ; `null` si absente/non cartographiée) → **niveau 2**.
3. sinon `bankLabelRaw` (narratif brut OBIE `TransactionInformation`) → italique atténué — **niveau 3**.
4. sinon **`LIBELLE_REPLI`** → italique atténué — **niveau 4**.

Consommateurs : `/transactions` via `versLigneUI` (`adapter.ts:152-170`, cascade complète) ;
**dashboard** via `transactions-table.tsx` (cascade avec `categorieFr={null}` — colonne
Catégorie dédiée, anti-doublon ; dette `TECH-DASHBOARD-CASCADE` **résolue 2026-07-10**).

**Le niveau 4 « Opération bancaire » ne s'atteint donc QUE si** : `clean_label` vide **ET**
`categorieFr` null **ET** `bank_label_raw` vide. C'est cette conjonction qu'il faut expliquer,
pas une lecture cassée.

### 2.3 Les trois causes réelles du résidu (par ordre d'impact)

- **(A) Absence RÉELLE amont — dominante.** L'API ne fournit pas de `CleanMerchantName`
  exploitable sur ~30 % des volumes (narratifs longs), et 93 % des catégories sont
  `UNCLASSIFIED`. Sur ces lignes, si `TransactionInformation` existe → on tombe au **niveau 3**
  (brut, lisible), pas au niveau 4. Le **niveau 4 pur** ne survient que quand `TransactionInformation`
  est **aussi** vide (constaté sandbox : « transactions sans libellé »). → **Fallback légitime,
  aucun correctif de lecture possible côté TYGR.**
- **(B) Lignes PÉRIMÉES (pré-fix).** Les transactions ingérées **avant** PROD-MERCHANT1
  (lecture à plat `undefined`) **et** avant le fix `Description`→`TransactionInformation` ont
  `clean_label` **ET** `bank_label_raw` NULL en base → niveau 4 garanti, alors même que le
  payload live porte peut-être la donnée. **Réparable par re-sync** (lot D), **borné à la
  fenêtre 92 j amont** (cf. §5.2). La sonde (§1.3) confirme l'ampleur.
- **(C) Étroitesse du mapping catégorie.** `CORRESPONDANCE_FR` (`categories-fr.ts`) est une
  liste fermée d'~17 clés ; toute catégorie OBIE hors liste → `CATEGORIE_FR_PAR_DEFAUT` →
  `traduireCategorieBanque` renvoie `null` → niveau 2 sauté. **Impact FAIBLE sur le libellé**
  (93 % sont `UNCLASSIFIED` de toute façon), mais c'est la dette liée citée par le brief
  (`TECH-MERCHANT-POLISH1` / `OBIE-CATALOG1`). Traitée en §6.3, hors cœur.

---

## 3. Correctif de lecture flat→`Enrichment{}` — STATUT : DÉJÀ LIVRÉ (NO-OP)

**Ne rien re-coder.** Preuve dans le code courant (`main`) :

- `versLignePersistee` (`orchestrateur.ts:110-160`) lit `const e = t.Enrichment;` puis
  `cleanLabel: chaineOuNull(e?.CleanMerchantName)` — imbriqué, avec normalisation `"" → null`.
- `chaineOuNull` (`orchestrateur.ts:65-68`) : `s?.trim()` → `null` si vide (le serializer amont
  pose `""`, pas `null` ; sans ça on persisterait un `clean_label` blanc, **pire** que le repli).
- `categorieAutoValide` + `CATEGORIES_OBIE_VIDES` (`{"uncategorized","unclassified"}`,
  inventaire base 2026-07-21) : `UNCLASSIFIED` → `primary_category = null`, pas de faux marqueur auto.
- TODOS `TECH-DASHBOARD-CASCADE` : **RÉSOLU 2026-07-10** (déclencheur = retour Etienne « j'ai
  encore des libellés "Opération bancaire" sur le dashboard alors que /transactions n'en a plus »).

Le seul geste résiduel au voisinage est **défensif** (lot S), pas correctif.

---

## 4. Lot S — Durcissement du bord amont : validation zod du payload (le vrai correctif durable)

> **C'est la pièce maîtresse de PROD-MERCHANT-1.** PROD-MERCHANT1 a été un « 100 % fallback
> silencieux » : le type TypeScript affirmait une forme (à plat) que le runtime ne servait pas,
> et **rien n'a crié**. Aujourd'hui le client fait un **cast brut** —
> `enveloppe = (await reponse.json()) as OmniFiEnveloppe<TData>` (`client.ts:255`) — donc **le
> même piège peut se rejouer** : une future dé-imbrication, un renommage `Enrichment` →
> `enrichment`, un changement de casse, et on retombe à 100 % de fallback **sans aucune alerte**.
> Une validation zod au bord transforme ce mode muet en **échec nommé et observé**.

### 4.1 Ce que le schéma valide (STRUCTURE, pas contenu)

- **Envelope** : `Data.Transaction[]`, `Links`, `Meta` (formes attendues, cf. `types.ts`).
- **Transaction** : `TransactionId` (string non vide), `AccountId`, `Amount{Amount:string,
  Currency:string(3)}`, `CreditDebitIndicator ∈ {Credit,Debit}`, `Status`, `BookingDateTime`
  (date parsable), champs optionnels tolérés.
- **`Enrichment`** : **objet optionnel** ; ses 6 clés sont des **strings tolérant `""`**
  (le vide est LÉGAL — c'est le défaut serializer, normalisé en aval). On **ne rejette pas**
  une transaction pauvre ; on rejette une transaction **mal FORMÉE**.
- **Montant (règle 8)** : `Amount` reste une **chaîne** validée par regex décimale (jamais
  `z.number()` — un `parseFloat` perdrait des centimes). Le schéma **n'introduit aucun float**.

### 4.2 Où l'insérer + politique d'échec (fail-loud vs fail-soft)

Point d'insertion : dans `client.requete<TData>` (`client.ts` ~L201-260), **après**
`reponse.json()`, un `schema.safeParse(...)` **remplace le cast**. Deux granularités à ne pas
confondre (aligné sur la mémoire `sync-fail-soft-observabilite`) :

- **Envelope malformée** (forme entière fausse, ex. `Data` absent, `Enrichment` dé-imbriqué en
  masse) → **fail-loud** : lever une **erreur nommée** `OmniFiPayloadInvalideError` (mappée,
  loggée structurée sans PII), **abandonner la page**. C'est le signal anti-récidive PROD-MERCHANT1.
- **Transaction unitaire malformée** dans une page globalement saine → **fail-soft par ligne** :
  écarter LA transaction, incrémenter un compteur `transactionsRejetees`, **log structuré**
  (`workspace_id`, `bank_account_id`, `omnifi_txn_id`, `raison` machine — **jamais le libellé**),
  continuer la page. Un catch trop large avalerait les gardes tenant → **re-throw sélectif** des
  erreurs de tenancy (leçon `sync-fail-soft-observabilite`).

> **Décision ouverte D-1 (§9)** : seuil de bascule soft→loud (ex. « si >X % d'une page est
> rejetée, traiter comme envelope malformée »). À trancher avec un chiffre issu de la sonde §1.

### 4.3 Journalisation & erreurs nommées (règle 3)

- Registre d'erreurs : `OmniFiPayloadInvalideError` (envelope) — code machine + message UI
  non-énumérant ; `transactionsRejetees` remonté dans `ResultatSync` pour observabilité.
- Logs structurés corrélés (`workspace_id`, `bank_account_id`, `connection_id`), **zéro PII** :
  jamais de `bank_label_raw`, `CleanMerchantName`, ni `cause` réseau brute (réutiliser
  `resumeCauseSure`, `client.ts`).

### 4.4 Nouvelle dépendance ?

`zod` est **déjà** au projet (schémas d'entrée des Server Actions, cf. règle 3 usuelle).
**Aucune dépendance nouvelle** — pas de justification Layer 1/2/3 requise, lockfile inchangé.

---

## 5. Lot D — Rétro-remplissage des lignes déjà ingérées

### 5.1 Qui est concerné

Uniquement les **lignes périmées (hypothèse B, §2.3)** : `clean_label` NULL (et/ou
`bank_label_raw` NULL) sur des transactions dont le **payload live porte la donnée**. La sonde
§1 en donne le volume. Si la sonde conclut « absence réelle » (hypothèse A) sur ces lignes,
**le lot D est sans objet** — on ne fabrique pas un marchand que l'amont n'a pas.

### 5.2 Mécanisme — RE-SYNC, jamais de migration de données ad-hoc

- **Voie unique** : re-synchroniser les comptes → l'**upsert idempotent** de
  `synchroniserCompte` réécrit `clean_label`/`bank_label_raw` à partir du payload courant.
  `resynchroniserConnexion` (`orchestration.ts:1557`, grain BANQUE natif) existe déjà.
- **Contrainte append-only ABSOLUE (règle 8 + section « Intégrité append-only »)** : le
  rafraîchissement passe par **UPDATE** (upsert `ON CONFLICT`), **jamais** par DELETE+INSERT.
  `transactions_cache` est append-only au DELETE (trigger `0004` + liste blanche). Un backfill
  qui « repartirait de zéro » est **interdit** et casserait la CI d'isolation.
- **Borne dure 92 j (amont, non contournable)** : les connexions `mcb_pro`/`absa_pro` sont
  plafonnées à 92 j côté extracteur Omni-FI (`_days_window(days_from=92)` codé en dur ; mémoire
  `profondeur-historique-92j-mcb-pro`). **Les lignes plus anciennes que 92 j ne peuvent PAS être
  re-remplies** : l'amont ne les sert plus. Elles restent au niveau 3/4 — **fait à assumer,
  pas un bug**. Ne PAS promettre un backfill profond.
- **Ne jamais réécrire `entity_id`** (invariant multi-tenant : l'upsert de re-sync ne réécrase
  jamais un `entity_id` assigné).

### 5.3 Décision ouverte D-2 (§9)

Déclencheur du re-sync : (a) manuel/ponctuel par banque (bouton existant), (b) systématique
post-déploiement de S, (c) ne rien faire si la sonde montre que le résidu est ~100 % hypothèse A.
À trancher **après** la sonde §1.

---

## 6. Lots optionnels / hors cœur (décisions ouvertes)

### 6.1 (H) Heuristique d'extraction marchand côté TYGR

Le CONSTAT montre une structure exploitable côté MCB (`CODE | LIBELLE | 00/00 | REF`, 100 % des
longs libellés MCB portent un `|`). Une fonction **pure** pourrait extraire un marchand du
segment lisible **quand `Enrichment.CleanMerchantName` est vide**, en amont de la cascade (nouveau
niveau 1-bis). **Non trivial** (SBM est 94,5 % majuscules / 45 % chiffres → peu exploitable ;
risque d'extraire du bruit). **Recommandation : chantier SÉPARÉ** (`PROD-MERCHANT-HEURISTIQUE`),
pas dans PROD-MERCHANT-1 — le fond appartient à l'amont (lot U). Décision H (§9).

### 6.2 (U) Demande d'évolution AMONT — déjà rédigée

Le CONSTAT §7 porte la demande à Omni-FI (par ordre d'impact) : extraire le marchand sur les
narratifs longs (~30 % du volume), exposer les segments séparément, champ de contrepartie
structuré, confirmer les plafonds 100/50 car. **Seul levier réel sur le fond.** Action = suivi
relationnel/canal Omni-FI, **hors code**. Ingérer `BankTransactionCode` /
`ProprietaryBankTransactionCode` (existent amont, non ingérés) est une piste TYGR annexe —
décision U (§9).

### 6.3 (C) Mapping catégorie — dette liée `TECH-MERCHANT-POLISH1` / `OBIE-CATALOG1`

Deux points cités par le brief :
- **Divergence dashboard ↔ table** : le dashboard affiche `categorieFr(t.primaryCategory)`
  (colonne dédiée) tandis que `/transactions` passe par `traduireCategorieBanque` (qui **rejette**
  le défaut vers `null` pour l'anti-doublon). Les deux dérivent de la **même** `CORRESPONDANCE_FR`
  (source unique) : pas de divergence de **données**, seulement de **présentation** (voulue).
- **`traduireCategorieBanque` (`adapter.ts:240`) non testé** : fonction **non exportée** → non
  couverte en unitaire aujourd'hui. **Combler** (cf. §7) — c'est un trou règle 3 réel, faible effort.

Élargir `CORRESPONDANCE_FR` a un **impact marginal** sur le libellé (93 % `UNCLASSIFIED`).
À raccrocher à `OBIE-CATALOG1`, **hors cœur** de ce chantier.

---

## 7. Critères de sortie (CLAUDE.md règle 3)

Le chantier touche la **couche d'ingestion** (pas une nouvelle route authentifiée), donc le
critère « 404 jamais 403 » ne s'applique pas tel quel ; les autres sont pleins et **livrés dans
le même PR** :

- [ ] **Validation zod stricte du payload amont** (lot S) : types, bornes, longueurs, casse ;
      montant validé en **chaîne** (jamais de float). Rejet **bruyant** avec code d'erreur nommé
      (`OmniFiPayloadInvalideError`) pour l'envelope ; **fail-soft observé** par ligne.
- [ ] **Chaque erreur a un nom** : code machine → message UI mappé ; `transactionsRejetees`
      exposé dans `ResultatSync`. Catch-all silencieux interdit ; re-throw sélectif des erreurs
      de tenancy.
- [ ] **Tests (heureux / échec / limite)** :
      - *Heureux* : payload `Enrichment` imbriqué complet → `clean_label` peuplé, pas de rejet.
      - *Échec structurel* : `Enrichment` dé-imbriqué / absent / renommé → `OmniFiPayloadInvalideError`
        levée (le test qui **échouerait** aujourd'hui faute de garde — c'est lui qui prouve S).
      - *Limite* : `CleanMerchantName === ""` → `clean_label` **null** (pas `""`), **aucun** rejet
        (le vide est légal) ; `TransactionInformation` null → `bank_label_raw` null ; catégorie
        `UNCLASSIFIED` → `primary_category` null + pas de marqueur auto.
      - *Cascade* : les 4 niveaux de `resoudreLibelle` (déjà couverts par
        `libelle-transaction.test.ts` — **ne pas dupliquer**, étendre si un niveau manque).
      - *Trou à combler* : **exporter et tester** `traduireCategorieBanque` (§6.3) — défaut → `null`,
        clé connue → FR, clé inconnue → `null`.
      - Réutiliser les fixtures existantes (`ingestion-orchestrateur.test.ts`), **sans** re-fabriquer
        un `Links.Next` trop favorable (piège `piege-fixture-demo-trop-favorable`).
- [ ] **Logs structurés corrélés** (`workspace_id`, `bank_account_id`, `connection_id`),
      **zéro PII** (règle 8).
- [ ] **Suite d'isolation IDOR / append-only** : verte. Le lot D ne DELETE jamais ; aucun nouveau
      chemin d'écriture hors `withWorkspace`.
- [ ] **Stop-loss (règle 5)** : `lint` + `tsc --noEmit` + build verts avant commit.

---

## 8. Impacts transverses (obligatoire)

- **Tenancy (règle 2)** : aucun nouvel accès DB hors `withWorkspace`. Le re-sync (lot D) emprunte
  le chemin d'ingestion existant, déjà scopé. La validation zod ne touche pas la couche data.
- **Append-only (règle 8)** : lot D en **UPDATE/upsert uniquement**, jamais DELETE ; ne pas
  ajouter `transactions_cache` à la liste blanche DELETE ; ne pas réécrire `entity_id`.
- **Pas de float (règle 8)** : le schéma zod valide `Amount` en **chaîne décimale** ; aucun
  formatage n'est introduit ici (l'affichage reste sur `format-montant.ts`).
- **i18n libellés** : `clean_label`/`bank_label_raw` restent la donnée BRUTE (langue source) ;
  la francisation ne concerne QUE la **catégorie** (`categories-fr.ts`, source unique) — ne pas
  « traduire » un marchand. Le repli « Opération bancaire » est FR par nature.
- **États d'affichage (convention Loading/Empty/Error/Partiel)** : inchangés. Le niveau 3 (brut)
  et 4 (repli) sont rendus **atténués + italique** — signal « non enrichi » à **documenter ou
  uniformiser** (dette `DESIGN-ITALIQUE-BRUT1`, hors cœur). Aucun état d'erreur n'est ajouté à
  l'écran : une transaction pauvre n'est pas une erreur système (erreur ≠ sortie, §3.4).
- **Visual QA (Gate 4)** : si le lot D change des libellés à l'écran, capter avant/après sur
  `/transactions` et le dashboard (route de démo si dispo) et comparer aux tokens (plein vs
  atténué). Pas de changement de tokens attendu.

---

## 9. Décisions ouvertes (à trancher — plusieurs dépendent de la sonde §1)

- **D-0 (gating)** : la sonde §1 confirme-t-elle la structure `Enrichment{}` live et le taux de
  vacuité ? (verrouille tout le reste).
- **D-1** : seuil de bascule fail-soft → fail-loud dans le lot S (§4.2) — quel % de rejet par page
  déclenche « envelope malformée » ? (chiffrer avec la sonde).
- **D-2** : déclencheur du re-sync (lot D, §5.3) — manuel / post-déploiement / rien.
- **H** : implémente-t-on l'heuristique d'extraction marchand (§6.1) dans un chantier séparé, ou
  attend-on l'amont ? (coût moyen, gain ~partie des 30 %, risque de bruit SBM).
- **U** : ouvre-t-on en parallèle l'ingestion de `BankTransactionCode` / `ProprietaryBankTransactionCode`
  (§6.2), et relance-t-on la demande d'évolution amont formellement ?
- **C** : élargit-on `CORRESPONDANCE_FR` maintenant (raccroché `OBIE-CATALOG1`) ou plus tard ?
  (impact libellé marginal).

---

## 10. Séquencement proposé (cœur = V + S + D)

1. **V — Sonde live sans PII** (§1). Gate. Produit un addendum chiffré. *(≈ 0,25 j)*
2. **S — Validation zod du bord** (§4) + tests règle 3 (§7). Correctif durable anti-récidive.
   *(≈ 0,5–1 j)*
3. **D — Re-sync des lignes périmées** (§5), **seulement si** la sonde le justifie (hypothèse B),
   borné 92 j, append-only strict. *(≈ 0,25 j opé + observation)*
4. **Trou test** : exporter + tester `traduireCategorieBanque` (§6.3). *(≈ 0,25 j)*
5. **H / U / C** : décisions ouvertes → chantiers séparés / suivi amont, **hors** ce PR.

**Frontières Git (rappel)** : implémentation sur branche `feat/prod-merchant-1` (fil séparé,
partant de `main` à jour) ; l'agent **s'arrête à la PR** ; l'humain valide (Visual QA + sens) et
merge. Aucun commit direct sur `main`.

---

## Annexe A — Références file:line (vérifiées 2026-07-23, `main`)

| Élément | Fichier:ligne |
|---|---|
| Type `OmniFiEnrichment` | `src/server/omnifi/types.ts` ~96-103 |
| Champ `Enrichment?` sur la tx | `src/server/omnifi/types.ts` ~127 |
| Cast brut du payload (point d'insertion zod) | `src/server/omnifi/client.ts:255` (`requete`) |
| `versLignePersistee` (mapping) | `src/server/ingestion/orchestrateur.ts:110-160` |
| `chaineOuNull` (`"" → null`) | `src/server/ingestion/orchestrateur.ts:65-68` |
| `categorieAutoValide` / `CATEGORIES_OBIE_VIDES` | `src/server/ingestion/orchestrateur.ts:~93-107` |
| `resoudreLibelle` (cascade) | `src/components/transactions/libelle-transaction.tsx:84-103` |
| `LIBELLE_REPLI = "Opération bancaire"` | `src/components/transactions/libelle-transaction.tsx:40` |
| `versLigneUI` (cascade `/transactions`) | `src/app/(workspace)/transactions/adapter.ts:152-170` |
| `traduireCategorieBanque` (non exporté, à tester) | `src/app/(workspace)/transactions/adapter.ts:240` |
| Table dashboard (cascade `categorieFr={null}`) | `src/components/dashboard/transactions-table.tsx:~64` |
| Colonnes `clean_label` / `primary_category` / `bank_label_raw` | `src/server/db/schema.ts:435 / 437 / 434` |
| `CORRESPONDANCE_FR` / `CATEGORIE_FR_PAR_DEFAUT` | `src/**/categories-fr.ts` |
| Re-sync connexion (lot D) | `src/server/.../orchestration.ts:1557` (`resynchroniserConnexion`) |
| Tests existants à étendre (ne pas dupliquer) | `tests/unit/{ingestion-orchestrateur,libelle-transaction,categories-fr}.test.ts` |

## Annexe B — Documents source

- `CONSTAT-qualite-libelles-omnifi.md` — diagnostic chiffré sur données réelles (§2 cascade,
  §3 formes, §4 champ OBIE en cause, §7 demande d'évolution amont).
- `DIAGNOSTIC-profondeur-historique.md` + mémoire `profondeur-historique-92j-mcb-pro` — borne 92 j.
- Mémoire `contrat-enrichment-imbrique` — statut « résolu, ne pas rediagnostiquer ».
- Mémoire `sync-fail-soft-observabilite` — patron fail-soft + re-throw tenancy pour le lot S.
