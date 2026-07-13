# PLAN — « Synchroniser mes comptes » : spinner puis rien

Branche : `fix/sync-spinner-sans-resultat` (depuis `origin/main` @ 9e5f442)
Date : 2026-07-13
Statut : **diagnostic clos, correctif arbitré**

---

## 1. Symptôme

Clic sur « Synchroniser mes comptes » → spinner → **rien**. Aucun message, aucune erreur.
Le dashboard affiche pourtant **87 comptes**.

## 2. Hypothèse initiale — RÉFUTÉE

> « Le sync voit zéro là où la page voit 87 → régression de portée entité depuis le merge
> `9e5f442` : un scope entité fuiterait dans le chemin de sync (ENTITY-WRITE-SCOPE1). »

Trois preuves la réfutent :

1. **`bank_connections` ne porte AUCUNE policy de portée.** Sa seule policy est
   `tenant_isolation` (migration 0003). `account_scope` vit sur `bank_accounts` (0016) et
   les 4 tables filles append-only (0017) — **jamais** sur `bank_connections`. Or le seul
   chemin vers `{erreur:null, succes:null}` est `r.connexions === 0`, et `connexions` compte
   des **connexions**. Un scope ne peut donc pas produire ce symptôme.
2. **L'utilisateur est ADMIN sans aucun scope** → `entityScope = GLOBALE`,
   `accountScope = GLOBALE`. (Le seul membre scopé est un VIEWER sur 5 comptes.)
3. **Le filtre en cause est ANTÉRIEUR au merge entités** : il vient de la PR #140
   (`feat(sync): borne le périmètre aux connexions déjà en base`), pas de `9e5f442`.

⚠️ Les « 87 comptes » du dashboard **ne prouvaient rien** : le layout lit délibérément
`listerComptes` dans une transaction **SANS viewFilter** (parade au bug #143 — sinon le
sélecteur de périmètre s'auto-amputerait). Il affiche donc le DROIT COMPLET, même sous filtre.

## 3. Cause réelle — vérifiée en runtime

| Côté | État observé (2026-07-13) |
|---|---|
| **Omni-FI** (`GET /connections`, HTTP **200**) | **1** connexion : `05358b93…` → Bank One, `active` |
| **Base** (`bank_connections`) | **2** connexions : `6a49e45c…` (SBM, 77 comptes) + `307f186e…` (MCB, 10 comptes), dernier sync **07/07** |
| **Intersection** | **∅** |

Le sync ne rafraîchit **que les connexions déjà en base** (filtre « 2bis », décision produit
assumée : on ajoute une banque par le widget, pas par le bouton Synchroniser). Aucune
connexion locale n'existe plus côté Omni-FI, et la seule qui y existe n'est pas en base
→ `connexionsATraiter = []` → `connexions === 0` → **`{erreur:null, succes:null}` → silence**.

**Les deux incidents se rejoignent** : si Bank One est connectée chez Omni-FI mais absente de
la base, c'est très probablement parce que **le widget s'est fermé sans message** au moment de
finaliser — le bug de la PR #200. La finalisation n'a jamais eu lieu.

> Piège de méthode : un premier `curl` avec `?clientUserId=` a renvoyé **403** et allait me
> faire conclure à un problème d'EndUser. Le client envoie en réalité **`client_user_id`**
> (snake_case) → **HTTP 200**. Toujours reproduire la requête du CODE, pas celle qu'on imagine.

## 4. Le vrai défaut logiciel

Ce n'est pas une régression d'isolation : c'est que **le sync est muet quand il n'a rien à
faire**, et qu'il **ignore en silence** les deux désynchronisations :

- une banque connectée chez Omni-FI mais **jamais rattachée** ici (action : finaliser) ;
- des banques d'ici qui **ne répondent plus** côté Omni-FI (action : reconnecter) — leurs
  comptes restent affichés avec un `last_synced_at` frais, donc **crus à jour**. C'est
  l'anti-pattern « comptes vides avec une date fraîche » déjà rencontré en production.

## 5. Correctif (arbitré : « message + détection des désyncs »)

| Lot | Fichier | Contenu |
|-----|---------|---------|
| L1 | `orchestration.ts` | Compteurs `nonRattachees` / `absentesAmont` ajoutés à `ResultatSynchronisation`. `absentesAmont` compare aux ids amont **bruts** (tous statuts) — sinon une connexion simplement inactive passerait pour disparue |
| L2 | `messages-sync.ts` **(nouveau)** | `supplementsDesync` / `messageAucuneConnexion` — fonctions **PURES** testées. Hors `actions.ts` : un fichier `"use server"` ne peut exporter que des fonctions async |
| L3 | `actions.ts` | 3ᵉ registre `info` sur `EtatFinalisation`. `connexions === 0` **ne peut plus être muet**. Les désyncs se disent AUSSI sur le chemin succès (sinon une banque morte reste invisible derrière un message vert) |
| L4 | `widget-feedback.tsx` | Prop `info` → `role="status"` + `text-muted` : **ni rouge** (rien n'a échoué), **ni vert** (rien n'a réussi). Placée APRÈS le succès (résultat principal d'abord) |
| L5 | `orchestration.ts` / `actions.ts` | Logs structurés `sync_diag` / `sync_resultat` — **observabilité permanente**. Ils tranchent en UN sync : amont muet / filtre de statut / base vide / mismatch d'ids / portée. Sans eux, `connexions: 0` confond toutes ces causes |
| L6 | `tests/unit/sync-messages.test.ts` | 8 cas, dont **le cas réel de l'incident** et l'invariant « ne renvoie JAMAIS une chaîne vide » |

### Trouvé en cross-review — trois défauts que le correctif initial laissait vivants

| # | Défaut | Correction |
|---|---|---|
| **B1** | **J'avais corrigé le MAUVAIS bouton.** `dashboard/sync-button.tsx` a un type local `Retour` qui **omet `info`** → sur l'écran d'accueil (le chemin le plus emprunté), l'incident était **intact** : `succes` null → aucun nœud rendu → spinner puis rien. `tsc` ne pouvait rien dire : le type est **structurel** et `info?` est optionnel — le champ était ignoré **en silence**. | `info` relayé + rendu, y compris **à côté du succès** (une banque morte ne doit pas rester invisible derrière le vert « Comptes à jour »). Commentaire posé sur le type pour le prochain champ ajouté |
| **B2** | Une connexion présente **des deux côtés** mais au statut non actif amont (`expired`…) ne tombait dans **aucun** compteur → message « Aucune banque connectée — **connectez-en une** » alors que l'utilisateur en a une, affichée juste au-dessus, et que la bonne action est de la **reconnecter** | 3ᵉ cas capturé (`inexploitables`). Fusionné avec `disparues` dans un compteur public unique `inutilisables` : deux causes, **une seule action** — reconnecter. Le log garde la distinction |
| **B3** | **Fausse accusation.** Si le listing amont est partiel, les connexions non lues passent pour disparues → « N banque(s) ne répondent plus — reconnectez-les » sur des banques **parfaitement saines** | La complétude se **DÉMONTRE** (cf. ci-dessous), elle ne se suppose pas |

### B3, second tour : la complétude se prouve, elle ne se défausse pas

Mon premier fail-safe (`Meta?.TotalPages ?? 1` + drapeau sur `Links.Next`) **ne mordait pas sur
le cas réel** — le réviseur l'a prouvé en runtime : `Meta` absent ⇒ `?? 1` ⇒ « 1 page » ⇒ sortie
par la branche « fin normale » ⇒ **listing déclaré complet alors qu'on ne sait rien**. Mon test
verrouillait un cas hypothétique et donnait une **fausse assurance**.

La parade proposée (« page courte ») avait elle-même un défaut : elle suppose que l'amont
**respecte** `pageSize`. Si l'API plafonne à 20 quand on demande 100, une page pleine paraît
courte ⇒ « complet » à tort ⇒ le bug revient.

**Contrat runtime vérifié (2026-07-13, `api-stage`) — la doc ment sur les deux points :**

```
clés racine : ['Data', 'Links', 'Meta']
Meta        : {'TotalPages': 1, 'TotalRecords': 1}
Links       : {'Self': '…'}          ← PAS de 'Next'
```

D'où la solution, qui ne dépend d'**aucune** hypothèse :

- **Pagination pilotée par `Meta.TotalPages`**, plus par `Links.Next` — celui-ci est **absent**
  en page unique, donc s'en servir comme condition d'arrêt faisait rater **toutes les pages 2+**.
  → **ferme au passage la dette « >20 connexions ignorées en silence »**.
- **Complétude prouvée par `Meta.TotalRecords`** : on a tout vu ssi `connexionsApiBrutes >=
  TotalRecords`. Aucune annonce = aucune preuve = **on se tait**. Double garde : même si
  `TotalPages` mentait, `TotalRecords` rattraperait.

Cinq cas ajoutés à la suite d'**isolation** (54/54), dont le scénario réel de l'incident, la
connexion `expired`, les deux fail-safes, et la lecture effective de la page 2.

## 6. Hors périmètre — actions opérationnelles (pas du code)

- **Reconnecter SBM et MCB** via le widget : leurs connexions n'existent plus côté Omni-FI.
  ⚠️ **Ne PAS supprimer leurs 87 comptes** — ce sont des données réelles (leçon déjà tracée).
- **`.env.prod` incohérent** : `OMNIFI_ENV="production"` + `OMNIFI_BASE_URL="https://api-stage.omni-fi.co"`
  + `AUTORISER_PRODUCTION=1`. L'API répond 200 (les clés matchent l'hôte), mais l'étiquette
  ment. À aligner. Voir aussi **WIDGET-ENV1** (`NEXT_PUBLIC_OMNIFI_ENV="production"` → CDN 403).
