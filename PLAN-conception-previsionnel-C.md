# PLAN — Conception de l'incrément C « Prévisionnel » (PROD-PREVISIONNEL-C1)

**Phase :** CONCEPTION (règle 1) — **aucun code applicatif écrit, aucune ligne livrée.**
**Date :** 2026-07-17 · **Auteur :** clawdy (conception, règle 1)
**Objet :** projeter les échéances sur le dashboard, pour qu'une échéance saisie
(« Commercial −10 000 Rs/mois ») fasse bouger la trésorerie **prévisionnelle**.
**Parent :** `PLAN-cadrage-scenario-previsionnel-fygr.md` — roadmap A→D. Ce plan couvre
**C uniquement** (A = vue tableau du réalisé, dépend de `categorySummary` ; B = registre
d'échéances, **livré** ; D = scénarios nommés, plus tard).
**Statut :** ✅ **D1 TRANCHÉE le 2026-07-17 par Etienne — option (b) « gabarit + tête »** :
une échéance récurrente = UNE ligne gabarit, occurrences projetées à la volée ; un statut
terminal sur la tête **n'éteint plus** les occurrences futures ; occurrences matérialisées
(§2 option 2) = dette **P1 `ECH-OCCURRENCES1`** (TODOS.md). D2/D3/D4 restent ouvertes → à
trancher avant le lot UI.

---

## 1. Le trou à combler (constat vérifié dans le code)

Aujourd'hui une échéance vit **uniquement** dans l'onglet Échéances : elle n'influence ni
le dashboard, ni les graphiques. `flux-bars.tsx` ne lit que `syntheseParMois`
(`transactions_cache`) — du **réalisé pur**. Aucun chemin ne relie `echeances` aux barres.

### 1.1 Constat critique confirmé : `recurrence` est stocké mais DORMANT

`src/server/repositories/echeances.ts:279` — `synthetiserHorizon` agrège :

```sql
where date_echeance <= aujourd'hui + N        -- 30 / 60 / 90
```

Le champ `recurrence` **n'est lu nulle part** dans le fichier (vérifié : il n'apparaît que
dans les types, l'INSERT et l'UPDATE). Chaque échéance est donc comptée **une seule fois, à
sa date stockée**. Conséquence exacte, telle qu'annoncée dans le brief et confirmée par
lecture du SQL : une échéance **mensuelle** du 11 juin de Rs 10 000 affiche **Rs 10 000 à
30 j, 60 j ET 90 j** — au lieu de 10 000 / 20 000 / 30 000.

> **Ce n'est pas seulement un manque : c'est un chiffre FAUX déjà en production**, sur un
> écran qui prétend dire « ce qui pèsera sur la trésorerie d'ici 90 jours ». La synthèse
> Échéances **sous-estime** aujourd'hui tout engagement récurrent. Cela pèse sur l'ordre de
> livraison (§8) : le correctif de la synthèse a de la valeur **seul**, sans dashboard.

**Le cœur de l'incrément C est donc un MOTEUR D'EXPANSION DES OCCURRENCES**, fonction
**pure** et testée, séparée du rendu — pas un travail de graphisme.

---

## 2. ⚠️ Pushback (règle 10) — l'angle mort structurel, à trancher AVANT tout code

**Le modèle de données ne distingue pas une ÉCHÉANCE d'une SÉRIE D'OCCURRENCES.** Sur
`echeances` (schéma L1128), `statut` et `montant_regle` vivent sur **la ligne**, pas sur
l'occurrence. Trois modes de défaillance concrets en découlent :

1. **Le loyer récurrent s'évapore au premier paiement.** `STATUTS_TERMINAUX = ["payee",
   "annulee"]` exclut la ligne de toute projection (`echeances.ts:54`). L'utilisateur qui
   pointe « payée » l'occurrence de **juin** d'un loyer mensuel efface **juillet, août et
   toutes les suivantes** de la prévision. La trésorerie prévisionnelle remonte
   silencieusement de 10 000 Rs/mois — un faux **optimiste**, le pire sens pour un outil
   de trésorerie.
2. **Un acompte de juin réduit à tort juillet et août.** Restant dû =
   `montant − coalesce(montant_regle, 0)`. Appliqué naïvement à chaque occurrence dérivée,
   un règlement partiel d'une seule occurrence rabote **toute la série**.
3. **Aucun geste ne permet d'arrêter une série.** Il n'existe **pas** de
   `recurrence_fin` (confirmé : la table n'a que `recurrence: varchar(12)` nullable, enum
   `mensuelle | trimestrielle`). Une récurrente est **infinie** ; le seul moyen de
   l'arrêter est de la marquer terminale — ce qui déclenche exactement le défaut n°1.

Ces trois défauts sont **une seule cause** : le registre B a été conçu comme une liste de
factures, et la récurrence y a été ajoutée comme une étiquette descriptive, sans sémantique
de projection. **L'incrément C est le moment où cette dette devient visible** — il ne peut
pas être « corrigé en UI ».

**Trois options, chiffrées :**

| | **Option 1 — Gabarit + tête** (reco MVP) | **Option 2 — Occurrences matérialisées** | **Option 3 — Série roulante** |
|---|---|---|---|
| Principe | La ligne est un **gabarit**. `statut`/`montant_regle` ne concernent que l'occurrence **tête** (rang 0, celle dont `date_echeance` est stockée). Les occurrences dérivées (rang ≥ 1) sont toujours au **montant plein**, statut ignoré. | Table `echeance_occurrences` (une ligne par échéance × date), statut/règlement **par occurrence**. | Marquer « payée » **fait avancer** `date_echeance` d'une période et remet le statut à `en_cours`. |
| Schéma | **Aucune migration** | Nouvelle table + FK composite scopée workspace + RLS 2 étages + liste blanche DELETE | Aucune migration |
| Sémantique « payée » sur récurrente | **Ambiguë** → cf. D1 | Exacte | « Paiement pointé, série continue » |
| Coût CC | ~½ j | ~2–3 j (migration + RLS + tests d'isolation + UI par occurrence) | ~1 j |
| Défaut | Ne résout pas le geste « pointer juin sans tuer la série » — le **reporte** | Le bon modèle, mais **hors budget de C** et rouvre B | **Réécrit `date_echeance`** → perte de l'historique de la série (table éditable, donc légal, mais on ne sait plus ce qui a été payé quand) |

**Recommandation :** **Option 1** pour C — elle livre le prévisionnel sans rouvrir B ni
toucher au schéma — **à la condition explicite de trancher D1** (que signifie « payée » sur
une récurrente ?). L'**Option 2 est le modèle cible** et doit être inscrite en dette
**P1** (`ECH-OCCURRENCES1`), déclencheur : le premier utilisateur qui pointe le paiement
d'une récurrente. **L'Option 3 est déconseillée** : elle détruit de la donnée financière
pour économiser une table.

> Ce pushback est **bloquant** : livrer C sans arbitrer D1 produit une trésorerie
> prévisionnelle qui ment dès le premier pointage. Le reste du plan suppose l'Option 1.

---

## 3. Méthode de projection (acter le cadrage §5.1)

**Prévisionnel piloté par les ÉCHÉANCES SEULEMENT** — « à titre indicatif ». Aucun modèle
statistique (moyenne glissante, saisonnalité, récurrence *détectée* dans l'historique).

- **L'historique reste le réalisé** (`transactions_cache`), **les échéances projetées sont
  le prévisionnel** — deux sources, jamais mélangées dans un même chiffre.
- **Pourquoi pas de modèle statistique au MVP :** une prévision extrapolée est
  *plausible* et *fausse*, donc indétectable par l'utilisateur — exactement le mode de
  défaillance que la règle 6 nous demande de fuir. Une prévision dérivée d'engagements
  saisis est **auditable** : l'utilisateur reconnaît ses propres échéances.
- Correspond au mode FYGR *« N'utiliser les échéances qu'à titre indicatif »*
  (cadrage §1.4) ; le mode *« ajuster automatiquement »* reste **hors C**.

---

## 4. Le moteur d'expansion (cœur de l'incrément)

### 4.1 Emplacement et nature

`src/lib/echeances-recurrence.ts` — module **NEUTRE** (`.ts`, pas de `"use client"`, zéro
React, zéro DB, zéro `Date` locale). Contrainte identique à `flux-projection.ts` : il sera
appelé depuis un **Server Component** *et* potentiellement depuis un module client — un
module `"use client"` ne peut pas être invoqué depuis le serveur (fix C2, déjà documenté).

### 4.2 Signature

```ts
/** Sous-ensemble PROJETABLE d'une échéance (ce que le moteur exige — rien de plus). */
export interface EcheanceProjetable {
  id: string;
  direction: EcheanceDirection;      // "encaissement" | "decaissement"
  montant: string;                   // chaîne décimale POSITIVE (règle 8)
  montantRegle: string | null;
  devise: string;
  dateEcheance: string;              // "YYYY-MM-DD" — date « nue » Maurice
  statut: EcheanceStatut;
  recurrence: EcheanceRecurrence | null;  // "mensuelle" | "trimestrielle" | null
}

export interface OccurrenceProjetee {
  echeanceId: string;
  direction: EcheanceDirection;
  /** Chaîne décimale POSITIVE (règle 8) — le SENS est porté par `direction`. */
  montant: string;
  devise: string;
  dateEcheance: string;              // "YYYY-MM-DD" de CETTE occurrence
  mois: string;                      // "YYYY-MM" — clé de jointure avec la grille
  /** 0 = occurrence TÊTE (date stockée) ; ≥1 = occurrence dérivée. */
  rang: number;
}

/**
 * Expanse les occurrences d'UNE échéance dans [bornes.debut, bornes.fin] (inclusifs,
 * dates « nues » Maurice). PURE, déterministe, sans `Date` locale ni fuseau implicite.
 */
export function expanserOccurrences(
  echeance: EcheanceProjetable,
  bornes: { debut: string; fin: string },
): OccurrenceProjetee[];
```

### 4.3 Règles de calcul (Option 1 — gabarit + tête)

1. **Statut terminal (`payee`/`annulee`) → `[]`**, récurrence comprise (dépend de **D1**).
2. **`recurrence === null`** → la tête seule, **si** `dateEcheance ∈ bornes`, sinon `[]`.
3. **Pas d'itération** : `mensuelle` → +1 mois ; `trimestrielle` → +3 mois.
4. **Montant** : rang 0 → **restant dû** (`montant − coalesce(montantRegle, 0)`) ;
   rang ≥ 1 → **montant PLEIN**. *(C'est la traduction directe de l'Option 1 : un acompte
   concerne le paiement en cours, pas les mois suivants.)*
5. **Clamp de quantième — NON CUMULATIF** (piège n°1, cf. §4.4) : chaque occurrence se
   calcule depuis le **quantième d'ORIGINE**, jamais depuis l'occurrence précédente :
   `jour(n) = min(quantièmeOrigine, dernierJourDuMois(mois n))`.
6. **Occurrences hors bornes ignorées** ; une tête antérieure à `bornes.debut` dont la
   série **rattrape** la fenêtre produit bien ses occurrences (avec leur rang réel).
7. **Garde-fou d'itérations** : la récurrence étant **infinie** (pas de `recurrence_fin`,
   §2.3), la boucle est bornée par `bornes.fin` **et** par un plafond dur
   (`MAX_OCCURRENCES`, ex. 240 = 20 ans mensuels) — fail-safe contre une borne aberrante.
8. **Aucun filtrage de devise ici** : le moteur expanse, l'agrégateur (§5) réduit à la
   devise de base. Séparation des responsabilités = testabilité.
9. **Fuseau (E20)** : le moteur ne manipule que des `YYYY-MM-DD` **déjà à Maurice** et de
   l'arithmétique entière année/mois/jour — **aucun `new Date()`**, aucune dérive possible.
   Le fuseau est posé **une seule fois**, en amont, par `dateCouranteMaurice()`
   (`src/lib/format-date.ts`, déjà utilisé par le repo). Patron identique à `grilleMois`
   (`dashboard.ts:619`), qui est pur pour exactement cette raison.

### 4.4 Cas de test obligatoires (la fonction est pure → tout est testable)

| # | Cas | Attendu |
|---|---|---|
| 1 | Non récurrente dans les bornes | 1 occurrence, rang 0 |
| 2 | Non récurrente hors bornes | `[]` |
| 3 | Statut `payee` / `annulee`, **même récurrente** | `[]` (cf. **D1**) |
| 4 | **Mensuelle 11/06, bornes juin→août** | **3 occurrences** : 11/06, 11/07, 11/08 — *le cas exact du constat : 10 000 / 20 000 / 30 000* |
| 5 | Trimestrielle 15/01, bornes jan→déc | 15/01, 15/04, 15/07, 15/10 |
| 6 | **Clamp non cumulatif** : mensuelle 31/01/2026 | 31/01, **28/02**, **31/03** ← *jamais 28/03* |
| 7 | Bissextile : mensuelle 31/01/2024 | 29/02/2024 |
| 8 | Trimestrielle 30/11 | → 28/02 (ou 29/02 si bissextile) |
| 9 | `montantRegle` sur récurrente | rang 0 = restant ; rang 1+ = **plein** |
| 10 | Tête AVANT `bornes.debut`, série rattrapant la fenêtre | occurrences incluses, **rangs réels** ; aucune ne porte le restant dû |
| 11 | Bornes inversées (`fin < debut`) | `[]` (jamais une boucle infinie) |
| 12 | Bornes à 100 ans | borné par `MAX_OCCURRENCES`, pas d'explosion mémoire |
| 13 | Montant à 2 décimales / restant nul | chaîne décimale exacte ; un restant `0.00` n'est **pas** projeté |

> **Le cas 6 est le piège n°1 du calcul de récurrence.** Un décalage naïf
> (`occurrence(n) = occurrence(n−1) + 1 mois`) fait dériver 31 jan → 28 fév → **28 mars →
> 28 avril…** : la série entière se décale d'un jour de manière permanente après le premier
> mois court. Ni `lint`, ni `tsc`, ni le build ne le voient — seul le test le voit. C'est
> précisément le type de défaut que la règle 6 vise.

### 4.5 Sommer sans float — point dur à ne PAS improviser

Les occurrences sont des **chaînes décimales** ; leur agrégation par mois est une
**addition de montants** (règle 8 : `parseFloat` **interdit** hors géométrie de barre).

**La primitive existe déjà** : `enCentimes(montant): bigint | null` / `depuisCentimes`
dans `src/components/ui/category/allocation.ts` — module neutre, pur, BigInt, écrit pour
exactement ce besoin (« centimes entiers pour éviter l'imprécision »).

**Ne pas dupliquer** (règle « source unique de formatage ») : la livrer par **extraction**
vers `src/lib/montant-centimes.ts` (module neutre), `allocation.ts` ré-important depuis
là. Déplacement **pur**, sans changement de formule — même patron que l'extraction de
`flux-projection.ts` hors de `flux-bars.tsx`. Un additionneur décimal maison dans le
moteur serait une **deuxième source de vérité** sur les montants.

> Alternative écartée : expanser en SQL (`generate_series`). Ça garderait l'agrégat en
> `numeric`, mais enfouirait la règle métier (clamp de quantième, tête vs dérivée) dans du
> SQL **non testable unitairement** — au moment précis où cette règle est le cœur de
> l'incrément et son principal risque de bug (cas 6). Le moteur pur est le bon choix ;
> §8 note l'exception pour C2.

---

## 5. Point d'ancrage UI retenu

### 5.1 Décision : ÉTENDRE la grille des barres vers l'AVANT (reco du brief — confirmée)

Le dashboard construit sa fenêtre ainsi (`(dashboard)/page.tsx:150-173`) :
`syntheseParMois(tx, { from: fromFlux, to })` + `grilleMois(nbMois, mois)` — une grille
qui **recule** depuis le mois d'ancrage (`dashboard.ts:619`, pure, testée).

L'ancrage retenu **prolonge cette grille de `nbMoisPrevision` mois vers l'avant** ; les
mois futurs sont alimentés par les occurrences projetées, rendus en **zone prévisionnelle**.
Aucune nouvelle courbe de position, aucun nouveau composant de graphe.

**Pourquoi c'est le bon choix ici :**
- Le design system **spécifie déjà** ce rendu — `docs/UI_GUIDELINES.md` §3.5
  « Prévisionnel vs Réalisé » : *« Barres entrées/sorties : opacité 100 % (réalisé) →
  **45 %** (prévisionnel) »*, fond `surface-forecast`, badge « Prévision », **séparateur
  vertical pointillé « aujourd'hui »** `line-strong`. Les tokens `surface.forecast`
  (`#EFEBDD`) et `chart.forecastFill` **existent déjà** dans `globals.css`. On implémente
  une spec écrite, on n'invente pas un langage visuel.
- §3.5 impose : *« le basculement réalisé→prévisionnel est TOUJOURS marqué par les DEUX
  signaux (fond/opacité + label) — jamais par la couleur seule »* (accessibilité).
- Réutilise `projeterSurGrille` / `maxFenetre` / `echelleNice` — le même axe, la même
  échelle, la même géométrie.

**Alternative mentionnée, hors MVP** (cadrage §1.2) : **courbe de position de trésorerie
running** façon FYGR (solde de départ + variations cumulées, aire `chart-forecastFill`).
C'est **la** représentation la plus parlante d'une prévision (« quand est-ce que je passe
sous zéro ? »), et §3.5 la spécifie aussi. Mais elle exige un **solde de départ fiable** —
or `balance_history` est **vide en Staging** et la courbe du dashboard a déjà dû être
recâblée sur le flux net pour cette raison (`page.tsx:130-133`). Une position projetée à
partir d'un solde de départ absent serait fausse. **Hors C**, à rouvrir quand les soldes
historiques existent.

### 5.2 Les 5 défauts de rendu que l'extension va provoquer (repérés à la lecture)

Ces points ne sont **pas** des détails d'implémentation : ce sont des bugs **garantis** si
le lot C3 est écrit sans eux.

1. **`aucunMouvement` masquerait la prévision.** `flux-bars.tsx:69-74` : si le réalisé est
   vide, `maxBrut === 0` → le composant rend « Aucun mouvement sur la période » **et sort**.
   Un workspace neuf **sans transactions mais avec des échéances saisies** — soit
   exactement le parcours de démo du brief — n'afficherait **rien**. `maxFenetre` doit
   couvrir les barres de prévision, et la condition de vide devenir
   « aucun réalisé **ET** aucune prévision ».
2. **L'échelle doit englober la prévision** (`echelleNice(maxBrut)`), sinon une grosse
   échéance future **déborde** de la zone traçable.
3. **La densité des labels** (`MAX_LABELS = 8`, `flux-bars.tsx:123`) est calculée sur
   `mois.length` : +3 mois de prévision **change le pas des labels** du réalisé. À vérifier
   au Visual QA (les bornes `i=0` et `i=dernier` restent garanties).
4. **L'`aria-label`** (`flux-bars.tsx:191`) annonce la fenêtre : il doit dire que le graphe
   **inclut une projection** — c'est la seule chose qu'un lecteur d'écran perçoit du
   basculement, l'opacité et le fond lui étant **invisibles** (§3.5 exige deux signaux ;
   pour un lecteur d'écran, aucun des deux n'est audible).
5. **Le tooltip** (`flux-bars.tsx:280`) doit distinguer un mois projeté (badge/mention
   « Prévision »), sinon un chiffre prévisionnel se lit comme du réalisé au survol.

### 5.3 États (checklist UI_GUIDELINES §6.5)

| État | Rendu |
|---|---|
| **Vide (aucune échéance future)** | **Pas de zone prévision du tout** — la grille reste celle d'aujourd'hui. Pas de colonnes fantômes à zéro : une prévision vide ≠ une prévision nulle. |
| **Vide (aucun réalisé, échéances présentes)** | Barres de prévision **seules** (cf. défaut n°1) — surtout pas « Aucun mouvement ». |
| **Vide (ni l'un ni l'autre)** | Message neutre existant, inchangé. |
| **Normal** | Réalisé opacité 100 % · séparateur « aujourd'hui » · prévision opacité 45 % sur fond `surface-forecast` + label. |
| **Autre devise** | Échéance en devise ≠ base : **jamais additionnée**, signalée par la note existante (`flux-bars.tsx:103`), étendue aux échéances. |
| **Erreur / chargement** | Inchangés — la prévision arrive dans le **même** payload serveur que le réalisé (pas de fetch client, pas de nouvel état). |

---

## 6. Invariants — comment chacun est tenu

| Invariant | Traitement |
|---|---|
| **Règle 8 (montants)** | Chaînes décimales de bout en bout ; agrégation en **centimes BigInt** (§4.5) ; `parseFloat` **uniquement** pour la hauteur de barre, comme aujourd'hui (`flux-projection.ts:62`) ; affichage via `formatMontant` seul. |
| **Mono-devise (DASH-FX1)** | Projection réduite à la **devise de base** ; `GROUP BY devise` conservé ; une échéance en autre devise est **signalée, jamais sommée**. Aucune conversion FX inventée. |
| **Fuseau Maurice (E20)** | Fuseau posé **une fois** en amont (`dateCouranteMaurice()`), moteur en arithmétique entière sur `YYYY-MM-DD`, **zéro `new Date()`** (patron `grilleMois`). |
| **Périmètre entité** | Lecture des échéances via `withWorkspace` **dans le `Promise.all` existant de la page** (`page.tsx:126`) → même `tx`, mêmes GUC (`app.current_workspace_id` + `app.current_entity_scope`), donc **mêmes deux étages RLS** que le reste de l'écran. **Aucun filtre d'entité en `.tsx`.** |
| **⚠️ viewFilter (piège connu)** | La page dashboard tourne **sous périmètre**. Le défaut d'auto-amputation déjà rencontré (`L8b-1` : *le layout lit la liste SANS viewFilter*) se rejouerait à l'identique si la lecture d'échéances passait par un **second** chemin. → **exigence : réutiliser la transaction de la page**, ne jamais ouvrir un `withWorkspace` parallèle pour la projection. |
| **Append-only** | Aucun impact : `echeances` est une table **éditable** (liste blanche DELETE, ECH-D3) ; C est **lecture seule** dessus. Aucune migration (Option 1). |

---

## 7. Décisions ouvertes — à trancher par l'humain (NON tranchées ici)

> **D1 est bloquante.** Les autres peuvent être tranchées au lancement du lot concerné.

**D1 — Que signifie « payée » sur une échéance RÉCURRENTE ?** *(bloquante, §2)*
- **(a)** « La série est close » — statut terminal ⇒ plus **aucune** occurrence projetée
  (comportement actuel de `STATUTS_TERMINAUX`, cohérent, mais **le geste "pointer le
  paiement de juin" détruit la prévision de juillet+**). Coût : 0. Nécessite un libellé UI
  explicite (« Clôturer la série »).
- **(b) (reco)** « Payée » **ne s'applique qu'à la tête** ⇒ les occurrences dérivées
  continuent d'être projetées. Cohérent avec l'Option 1 (rang 0 = tête). Mais alors une
  récurrente **ne peut jamais être clôturée** sans être supprimée → exige au minimum une
  dette P1 nommée + un libellé UI honnête.
- **(c)** Ni l'un ni l'autre : **faire l'Option 2** (occurrences matérialisées) maintenant,
  et accepter +2–3 j sur C (rouvre B, migration, RLS, tests d'isolation).

**D2 — Le mois COURANT est à cheval : réalisé + échéances restantes du mois ?**
- **(a) (reco)** Barre **empilée** : segment réalisé (100 %) + segment prévision (45 %) sur
  la même colonne. C'est le comportement FYGR (« colonne double : *Réalisé à date* **et**
  *Prévision* », cadrage §1.1) et §3.5 le permet tel quel (l'opacité fait le travail).
- **(b)** Mois courant = **réalisé seul**, prévision à partir du mois suivant. Plus simple,
  mais la colonne du mois courant est **incomplète sans le dire** — une échéance due le 28
  d'un mois consulté le 3 est invisible.
- Choix structurant : il fixe où tombe le **séparateur « aujourd'hui »** (§3.5).

**D3 — Profondeur de la prévision (`nbMoisPrevision`).**
- Fixe (**3 mois**, reco : aligné sur les horizons existants 30/60/90) · proportionnelle à
  la fenêtre choisie · ou pilotée par la toolbar (nouveau contrôle, coût UI).

**D4 — La prévision s'affiche-t-elle sous une PLAGE de dates précise et passée ?**
- **Reco : non.** La toolbar permet une plage précise (`TOOLBAR-DATE-PRECISE1`). Sur
  « janvier→mars », des colonnes de prévision seraient **absurdes** (l'utilisateur regarde
  le passé). **Règle proposée : la zone prévision n'apparaît que si la fenêtre atteint le
  mois courant.** À valider — sinon le libellé de période mentirait (piège déjà documenté :
  *« sous une PLAGE précise, "N derniers mois" serait FAUX »*, `flux-bars.tsx:57-60`).

---

## 8. Découpage en unités livrables

| Lot | Contenu | Dépend de | Valeur propre | Coût CC |
|---|---|---|---|---|
| **C0** | **Extraction** `enCentimes`/`depuisCentimes` → `src/lib/montant-centimes.ts` (déplacement **pur**, `allocation.ts` ré-importe). | — | Source unique des montants | ~1 h |
| **C1** | **Moteur pur** `echeances-recurrence.ts` + **les 13 cas de test** (§4.4). **Zéro UI, zéro DB.** | C0, **D1** | Le cœur, testé et revu isolément | ~½ j |
| **C2** | **Fix `synthetiserHorizon`** : 30/60/90 comptent enfin les **occurrences**. Corrige un **chiffre faux déjà en prod** (§1.1). | C1 | **Forte, seule** — répare l'onglet Échéances sans toucher au dashboard | ~½ j |
| **C3** | **Agrégateur serveur** `projeterEcheancesSurGrille` (occurrences → `MoisAffiche` prévisionnels, devise de base, centimes) + lecture dans le `Promise.all` **existant** de la page + test d'isolation (périmètre entité). | C1 | — (technique) | ~½ j |
| **C4** | **UI** : grille étendue, opacité 45 %, fond `surface-forecast`, séparateur « aujourd'hui », badge, tooltip, `aria-label`, les **5 défauts** de §5.2, les **états** de §5.3 + **Visual QA** (Gate 4) contre §3.5. | C3, **D2/D3/D4** | Le livrable visible | ~1 j |

**Ordre recommandé : C0 → C1 → C2 → C3 → C4.**

> **Pourquoi C2 avant le dashboard :** il transforme un **chiffre faux en production** en
> chiffre juste, il est **testable sans UI**, et il valide le moteur sur un écran **déjà
> livré** avant qu'on ne construise le prévisionnel par-dessus. Si le moteur est faux, on
> l'apprend sur C2 — pas au Visual QA de C4.
>
> **Note technique C2 :** `synthetiserHorizon` agrège aujourd'hui **en SQL**
> (`::numeric(15,2)::text`, `echeances.ts:294`). L'y brancher signifie **rapatrier** les
> échéances projetables puis agréger **en TS** (centimes BigInt, C0) — ou dupliquer la
> règle de récurrence en SQL. **Reco : agrégation TS**, source unique de la règle. C'est un
> écart assumé au commentaire « agrégats calculés EN SQL » du repo : la contrepartie
> (récurrence testable unitairement, cf. cas 6) le vaut. **À noter en revue** (règle 6) —
> le volume est borné (registre manuel, pas `transactions_cache`).

**Exit criteria** (règle 3) : aucun nouvel endpoint ni Server Action (C est **lecture
seule**, dans la transaction existante) → pas de nouvelle surface d'authz. Restent
**bloquants** : suite d'isolation verte (périmètre entité sur la projection), les 13 cas
du moteur, `lint`/`tsc`/build (règle 5), Visual QA §3.5 (Gate 4).

---

## 9. Ce que ce plan NE fait PAS

- **Aucune ligne de code applicatif** (règle 1) — ce document est le livrable.
- **Pas de scénarios nommés** (incrément D), **pas de vue tableau** (incrément A, dépend de
  `categorySummary` — dont l'arbitrage D1/D2/D3 est **lui aussi en attente**).
- **Pas de modèle statistique** (§3), **pas de conversion FX** (DASH-FX1), **pas de courbe
  de position** (§5.1), **pas de nettage des virements internes** (cadrage §3.2 — la
  projection d'échéances **n'y touche pas** : un virement interne n'est pas une échéance).
- **Pas de migration** — sous réserve de **D1** ; l'option (c) en exigerait une.

---

## 10. Synthèse pour l'arbitrage

1. Le constat du brief est **exact et vérifié dans le code** : `recurrence` est stocké et
   jamais lu ; la synthèse 30/60/90 **sous-estime aujourd'hui** tout engagement récurrent.
2. L'ancrage recommandé (**étendre les barres vers l'avant**) est **déjà spécifié** par
   UI_GUIDELINES §3.5, tokens compris — faible risque, forte cohérence.
3. **Mais l'angle mort est ailleurs** : le modèle ne distingue pas une échéance d'une série
   d'occurrences (§2). **D1 doit être tranchée avant la première ligne de code** — sinon la
   trésorerie prévisionnelle remonte silencieusement au premier paiement pointé.
4. **Livrer C2 tôt** : il répare un chiffre faux en production, sans dépendre de l'UI.

**Décisions attendues : D1 (bloquante), puis D2 / D3 / D4 avant le lot C4.**
