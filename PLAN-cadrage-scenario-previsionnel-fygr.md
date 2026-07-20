# PLAN — Cadrage Scénario / Prévisionnel FYGR (PROD-SCENARIO-FYGR1)

**Phase :** Cadrage produit / Benchmark — **LECTURE SEULE, aucun code, aucune fonctionnalité
construite.**
**Date :** 2026-07-16 · **Auteur :** clawdy (conception, règle 1)
**Objet :** benchmarker la fonctionnalité **Prévisionnel + Scénarios** de FYGR (l'ancien
outil) et la **vue tableau** (ventilation tabulaire catégories × mois), pour cadrer les
onglets TYGR aujourd'hui vides (**Dashboard** en mode tableau, **Échéances**, **Graphiques**).
**Ne tranche pas** : décrit le benchmark, challenge, recommande un découpage. L'humain arbitre.
**Cousin de** `PLAN-cadrage-graphs-fygr.md` (qui couvrait les GRAPHES et excluait
explicitement le moteur de scénarios) et des dettes `NAV-ECHEANCES1` / `NAV-GRAPHIQUES1`.

---

## 0. Limite de méthode à déclarer d'emblée (honnêteté)

> **Je ne peux pas visionner ni analyser la playlist vidéo YouTube fournie**
> (`youtube.com/.../PLBZhl8tmO9J7Vg5O9j3MmS96eWXRPBMUa`). Ce cadrage s'appuie
> **UNIQUEMENT** sur les captures d'écran versionnées dans
> `docs/benchmarks/FYGR/` (dashboard, graphics, deadlines, transactions, categories).
> Si la playlist montre des interactions non visibles sur les captures (édition de
> scénario, saisie de prévision manuelle, moteur de formules en action), **ces éléments
> manquent ici** et devront être ajoutés par un visionnage humain, ou par des captures
> supplémentaires déposées dans `docs/benchmarks/FYGR/`.

---

## 1. Ce que FYGR fait (benchmark factuel, à partir des captures)

FYGR (produit de trésorerie français, interface EN dans les captures, workspace de démo
« ovnicame ») organise la prévision autour de **trois briques imbriquées** :

### 1.1 La « Vue tableau » — matrice de trésorerie (`1_dashboard/accueil-6.png`)

Le Dashboard bascule entre une **vue courbe** (`accueil.png`) et une **vue tableau**
(toggle en haut à droite, à côté de « Scénario »). La vue tableau est le cœur :

- **Colonnes = périodes** : `DÉC.25 · JAN.26 · … · JUIN.26 (Réalisé à date)` **puis**
  `JUIN.26 · JUIL.26 · AOÛT.26 · SEPT.26 (Prévision)`. La colonne du mois courant existe
  en DOUBLE : « réalisé à date » et « prévision ». Les mois futurs sont marqués
  **Prévision**.
- **Bloc haut (synthèse)** : `Position début de période`, `Entrées` (vert ↓),
  `Sorties` (rouge ↑), `Variation`, `Position de fin de période` — une valeur par mois.
- **Bloc bas (ventilation par catégorie, lignes repliables ▸)** : `Incomes`, `Suppliers`,
  `G&A expenses`, `Employees`, `Taxes`, `Financial debts`, `Uncategorized` — chaque
  catégorie a son montant mensuel, réalisé puis prévu.
- **Sélecteurs** : `Comptes`, `Périodicité`, un sélecteur de scénario (« Central »),
  bouton **Scénario**, toggles de représentation (barres / courbe / tableau).
- Panneau gauche : `SOLDE` (aujourd'hui) + `DÉTAILS` du mois (Entrées / Sorties /
  Variation).

C'est **la ventilation tabulaire** dont parle le chantier 3 : mêmes catégories que le
donut, mais dépliées **catégorie × mois** avec une colonne réalisé et une colonne prévision.

### 1.2 Le Prévisionnel — projection des mois futurs (`accueil.png`, `accueil-6.png`)

Sur la courbe, une **zone grisée à droite** = le prévisionnel (projection). Dans le
tableau, ce sont les colonnes « Prévision ». La projection est dérivée de l'historique
**et** peut être ajustée par les échéances (§1.4).

### 1.3 Les Scénarios nommés — what-if (`accueil-8.png`)

Panneau « MES SCÉNARIOS » + modale **« Ajouter un scénario »** avec un champ *Nom du
scénario* (placeholder « Ex : Appel d'offre AX-001 »). Un scénario par défaut « Central »
existe ; l'utilisateur crée des variantes nommées (un appel d'offre gagné, un gros achat
différé…). Chaque scénario est une **surcouche de prévision** re-jouée sur la même
matrice, sélectionnable dans le dropdown de scénario.

### 1.4 Les Échéances — factures manuelles qui nourrissent la prévision (`3_deadlines/deadlines.png`, `accueil-11.png`)

Onglet **Deadlines** : liste de factures **Customers / Suppliers** avec colonnes
`Invoice No · Deadline · Projection · Balance (incl. VAT) · Description · Category ·
Status`, un bouton **« Add an invoice »**, un filtre `In progress`, et un lien
**« See my rules »**. Panneau gauche : encours `Customers / Suppliers / Global` sur
`30 days`.

La modale **« Paramétrer l'usage des échéances »** (`accueil-11.png`) relie échéances et
prévision, avec deux modes :
- *Ajuster automatiquement le prévisionnel quand les échéances dépassent les objectifs
  initiaux* ;
- *N'utiliser les échéances qu'à titre indicatif (barres de progression)*.
+ une option *Afficher les barres de progression dans le dashboard*.

Donc l'Échéancier **n'est pas** un simple registre : c'est **la source de saisie manuelle
du prévisionnel** (les factures à venir ajustent la projection).

### 1.5 Rappel — hors périmètre déjà tracé (cf. `PLAN-cadrage-graphs-fygr.md` §5)

Le **moteur de formules** FYGR (`VAL`/`SUM`/`SI`…, un tableur d'indicateurs au-dessus des
catégories) et les **rapports nommés persistés** ont déjà été jugés **hors MVP** dans le
cadrage graphes. Ce cadrage-ci ne les rouvre pas.

---

## 2. Correspondance avec l'existant TYGR

| Brique FYGR | Onglet TYGR cible | État TYGR | Dette liée |
|---|---|---|---|
| Vue tableau (matrice cat × mois) | Dashboard (mode tableau) | Non existant — on a la courbe flux (`flux-*`) et le donut cat en cadrage | PROD-GRAPHS-FYGR1 (donut/barres cat) |
| Ventilation par catégorie | Graphiques | Donut/barres cat à produire (repo `categorySummary`) | NAV-GRAPHIQUES1 |
| Prévisionnel (colonnes futures) | Dashboard / Échéances | **Absent** | *(nouveau)* |
| Scénarios nommés (what-if) | Dashboard | **Absent** | *(nouveau)* |
| Échéances (factures → prévision) | **Échéances (onglet vide)** | **Absent** — onglet à activer | NAV-ECHEANCES1 |

`NAV-ECHEANCES1` posait déjà la question métier exacte : *« prévisionnel ? factures à
venir ? rappels ? »*. **Le benchmark FYGR y répond : Échéances = registre de factures
Customers/Suppliers qui alimente le prévisionnel.** C'est la pièce maîtresse.

---

## 3. Challenge (règle 10 — Staff Engineer)

1. **Ce n'est pas UN chantier, c'est une CHAÎNE de dépendances.** La matrice tabulaire
   suppose la ventilation par catégorie (pas encore produite) ; le prévisionnel suppose un
   modèle de projection ; les scénarios supposent le prévisionnel ; les échéances supposent
   une table de factures + un moteur de règles de récurrence. Livrer « le scénario FYGR »
   d'un bloc = un chantier de plusieurs semaines mal borné. → **Découper en incréments
   livrables** (§4), chacun ayant une valeur propre.

2. **Choc frontal avec deux invariants TYGR — le multi-devise et les virements internes.**
   FYGR est **mono-€ et mono-compte** : il additionne tout dans une seule matrice sans
   risque. TYGR est **multi-devise (MUR/USD/EUR)** et **multi-comptes/multi-entités** :
   - une matrice « total unique » **viole** DASH-FX1 (pas d'addition cross-devise sans
     taux annoté, règle 8) → il faut une matrice **par devise** ou attendre la conversion FX ;
   - les **virements internes** (une sortie sur un compte = une entrée sur un autre)
     **gonflent** entrées et sorties agrégées → la ligne « Entrées/Sorties » de la matrice
     sur-représente des flux fantômes. Déjà identifié comme non trivial dans
     `PLAN-cadrage-graphs-fygr.md` §5.2. **À cadrer AVANT toute matrice agrégée.**

3. **Le prévisionnel est un modèle, pas un affichage.** « Projeter les mois futurs »
   demande de choisir une méthode (moyenne glissante ? récurrence détectée ? saisie
   manuelle via échéances ?). Sans décision explicite, on livre une prévision fausse qui
   décrédibilise l'outil. FYGR combine **historique + échéances manuelles** ; c'est un
   choix produit à acter, pas un détail d'implémentation.

4. **Périmètre entité.** La matrice et le prévisionnel doivent respecter les deux étages
   d'isolation (tenant + entité). Une prévision agrégée « groupe » vs « par entité » suit
   le même arbitrage que la courbe multi-série (DASH-CASHFLOW-MULTISERIE). À ne pas oublier
   au cadrage, sous peine de re-câbler la RLS après coup.

**Verdict :** la fonctionnalité est un **différenciateur produit fort** (c'est ce qui fait
la valeur de FYGR), mais elle est **prématurée tant que la ventilation par catégorie et
la conversion FX / le nettage des virements internes ne sont pas tranchés**. Le bon
premier incrément n'est pas « le scénario », c'est **la vue tableau du RÉALISÉ**
(catégories × mois passés), qui a de la valeur seule et débloque tout le reste.

---

## 4. Découpage recommandé (incréments, du plus sûr au plus ambitieux)

1. **Incrément A — Vue tableau du RÉALISÉ (catégories × mois passés).** Réutilise le repo
   `categorySummary` à produire (PROD-GRAPHS-FYGR1) + `date_trunc('month')`. **Par devise**
   (pas de total cross-devise). Valeur immédiate : la ventilation tabulaire du chantier 3,
   sans aucun modèle de prévision. **Pré-requis** : donut/barres cat (axe catégorie).
2. **Incrément B — Onglet Échéances (registre de factures).** Table `echeances`
   (Customers/Suppliers, deadline, projection, montant TTC, catégorie, statut), saisie
   manuelle, scopée tenant + entité. Répond à NAV-ECHEANCES1. Valeur seule : suivi des
   factures à venir, **sans** encore alimenter la prévision.
3. **Incrément C — Prévisionnel simple.** Colonnes futures dérivées des échéances de B
   (mode « à titre indicatif » d'abord, le plus honnête). Décision produit sur la méthode
   de projection AVANT de coder.
4. **Incrément D — Scénarios nommés.** Surcouches what-if sur la prévision de C. Le plus
   ambitieux ; ne se justifie qu'une fois A–C solides.

Chaque incrément = son propre plan de conception (règle 1) au moment de son lancement.
Ce document ne fait que **cadrer et ordonner**.

---

## 5. Décisions à poser (à trancher par l'humain — NON tranchées ici)

1. **Méthode de projection du prévisionnel** : historique (moyenne glissante / récurrence)
   vs saisie manuelle (échéances) vs hybride (comme FYGR). Structurant — à trancher avant
   l'incrément C.
2. **Matrice par devise vs total converti** : reprise de DASH-FX1. Défaut sûr = **une
   matrice par devise** (interdit d'imiter le « total unique » de FYGR).
3. **Traitement des virements internes** dans la matrice agrégée (exclure / neutraliser /
   annoter). Sans réponse, la ligne Entrées/Sorties est fausse.
4. **Granularité entité** de la matrice/prévision (groupe vs par entité) : même arbitrage
   que la courbe multi-série.
5. **Périmètre** : moteur de formules et rapports persistés restent **hors** de ce chantier
   (déjà tracés hors MVP dans PLAN-cadrage-graphs-fygr.md).

---

## 6. Recommandation

**Traiter le « scénario FYGR » non comme une feature mais comme une ROADMAP en 4 incréments
(A→D).** Commencer par **l'incrément A (vue tableau du réalisé)**, qui livre la ventilation
tabulaire demandée (chantier 3) sans dépendre d'aucun modèle de prévision, puis
**l'incrément B (onglet Échéances)** qui répond à NAV-ECHEANCES1. Le prévisionnel (C) et
les scénarios (D) ne se lancent qu'après décision produit sur la **méthode de projection**
et résolution des invariants **FX / virements internes**.

**Pré-requis transverse :** l'axe CATÉGORIE (donut/barres, repo `categorySummary`) de
PROD-GRAPHS-FYGR1 conditionne A **et** la matrice. Le livrer d'abord.

**Déclencheur de réouverture :** visionnage humain de la playlist FYGR (pour capter les
interactions non visibles sur les captures) OU dépôt de captures complémentaires dans
`docs/benchmarks/FYGR/` couvrant l'édition de scénario et la saisie de prévision.
