# Retours dogfooding Etienne — notes carnet du 2026-07-09 (clarifiées le même jour)

Contexte : transcription des notes carnet d'Etienne (2 pages), **entièrement
clarifiées par Etienne en session** — plus aucun item illisible. Deux erreurs de
lecture corrigées : « enlever la phrase au compte de la caisse » = **« enlever la
prise en compte de la casse »** (matching règles ↔ catégories) ; « masquer une
catégorie » = **« modifier le nom d'une catégorie »**.

Organisation en 5 chantiers code (A–E, branchés depuis `main`) + 3 cadrages P2
(docs seulement). Règles applicables : règle 1 (plan sur disque avant code),
règle 6 (revue par contexte frais), HITL (l'agent s'arrête à la branche prête
pour PR ; push/PR/merge + Visual QA Gate 4 = Etienne). Aucun item ne touche
l'isolation tenant / append-only / montants en dette → pas de P0.

## Les demandes clarifiées (verbatim condensé)

1. **Devises du dashboard** : l'affichage est « un mélange de pleins de textes
   différents » → tout mettre sous la même forme (source unique
   `format-montant.ts` / `format-date.ts`).
2. **Top contreparties** : top 5 seulement (« sinon c'est trop grand et ça ne sert
   à rien ») + **bug** : le sélecteur de période (1 mois / 3 mois / 6 mois…) ne
   change jamais le contenu de la carte → câbler la période (visualisation
   chronologique).
3. **Menu déroulant des transactions** : (a) bug récurrent de « banque
   invisible » ; (b) porter le même menu déroulant que le dashboard (classement
   accordéon par entités/titulaire).
4. **Catégorisation — plusieurs problèmes** :
   - une catégorie créée pendant la catégorisation arrive bien dans Règles mais
     **n'apparaît pas dans le menu des catégories existantes** (pas stockée/rafraîchie) ;
   - on peut **créer plusieurs fois la même catégorie** (« VAT » en double) ;
   - sur la ligne transaction (« achat 1 → 1 catégorie »), **on ne voit pas
     laquelle** → afficher le nom de la catégorie ;
   - organiser comme FYGR : **CATÉGORIE (ex. Employés) → SOUS-CATÉGORIE (ex.
     Commercial)** ;
   - **lien direct** depuis la catégorisation pour créer une règle ;
   - pouvoir **renommer** une catégorie.
5. **Casse** : enlever la prise en compte de la casse dans Règles par rapport aux
   catégories.
6. **Ordre de priorité des règles** : rajouter une explication/du texte (« c'est
   pas clair »), ou une meilleure UX/UI.
7. **Prévisions** : un tableau ou un moyen de visualiser proprement scénarios et
   échéances (les prévisions), **pas mélangé avec les transactions**.
8. **Intercompany** : commencer à réfléchir/consigner le transfert
   inter-compagnies ; pouvoir regarder des entrées/sorties **nettes** et une autre
   vue entrée/sortie (brut).
9. **Assignation comptes → entités (admin)** : Omni-FI crée des BU dupliquées
   (« airport lmt » vs « airport limited » = même BU) → il faut **migrer les
   comptes d'une entité à l'autre**, idée : drag & drop, simple et élégant.
10. **Fraîcheur** : app de prise de décision → afficher **l'heure précise du
    dernier sync** (heure de Maurice, conversion `Indian/Mauritius` explicite).
11. **Recherche** : barre de recherche par mots-clés dans Transactions.
12. **Description** : au clic sur une transaction, description **plus grosse,
    pourquoi pas en bold**.

## Découpage en chantiers

| Chantier | Branche | Contenu (IDs TODOS) | Plan |
| -------- | ------- | ------------------- | ---- |
| A — Batch UI dashboard/transactions/règles | `fix/feedback-0709-ui-batch` | FB0709-DASHBOARD-DEVISES1, FB0709-TOPVENDORS5, FB0709-TX-CATEGORIE-VISIBLE1, FB0709-TX-DESCRIPTION1, FB0709-REGLES-PRIORITE-AIDE1, FB0709-SYNC-HEURE-MU1 (+ vérif FB0709-SYNC-MANAGER1) | `PLAN-feedback-0709-ui-batch.md` |
| B — Hygiène catégories | `feat/categories-hygiene` | FB0709-CAT-PICKER-FRAICHEUR1, FB0709-CAT-DOUBLONS1, FB0709-CAT-RENOMMER1, FB0709-REGLES-CASSE1, FB0709-REGLES-LIEN1 | `PLAN-categories-hygiene.md` |
| C — Sélecteur transactions | `fix/transactions-selecteur-entites` | FB0709-TX-SELECTEUR1 (bug banque invisible + accordéon entités) | `PLAN-transactions-selecteur-entites.md` |
| D — Recherche transactions | `feat/transactions-recherche` | FB0709-RECHERCHE-TX1 | `PLAN-transactions-recherche.md` |
| E — Ré-assignation entités | `feat/entites-reassignation-dragdrop` | FB0709-ENTITES-DRAGDROP1 | `PLAN-entites-reassignation-dragdrop.md` |
| Cadrages (docs, pas de code) | `chore/feedback-0709-docs` | FB0709-PREVISIONS-VUE1, FB0709-INTERCO1, FB0709-SOUS-CATEGORIES1 | `CADRAGE-previsions-scenarios.md`, `CADRAGE-transferts-intercompany.md`, `PLAN-sous-categories.md` |

Note chantier E : la branche wip d'Etienne (`wip/vue-complete-20260708`) porte un
Lot 2 non mergé « sélecteur Entité cible via ui/select » — le plan E doit s'y
référer sans le dupliquer (la vue drag & drop est complémentaire du select).

## Définition de « fini » (loop du 2026-07-09)

Par chantier code : plan sur disque → worktree/branche dédiée depuis `main` →
implémentation → gates verts (lint, tsc, build, vitest hors tests DB — la stack
Docker n'existe pas en sandbox) → revue par subagent à contexte frais → commit.
Push impossible depuis la sandbox (proxy) : branches locales, Etienne pousse et
ouvre les PR. Visual QA Gate 4 : à la charge d'Etienne avant merge.
