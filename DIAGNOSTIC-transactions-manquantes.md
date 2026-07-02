> ## VERDICT FINAL (2026-07-02) — lire d'abord
>
> **Cause probable : staleness amont, PAS un bug TYGR.** Preuve par le code
> (`orchestrateur.ts` L166-198, `repositories/ingestion.ts` L161-231) :
> - `versLignePersistee` est un **map 1:1** (aucun filtre) ;
> - `upsertTransactions` **insère chaque ligne** ; le `onConflictDoUpdate` ne collapse
>   que sur un vrai doublon `(omnifiTxnId, transactionDate)` — 0 doublon prouvé ;
> - la boucle de pages **n'a aucun try/catch** ; `marquerSynchronise` (`last_synced_at`)
>   n'est atteint **qu'après** une boucle complète **sans exception**.
>
> Donc **`last_synced_at` posé (06:06) ⟹ la boucle est allée au bout sans lever ⟹
> toutes les pages lues ont été upsertées**. La base a 40 lignes (avril) ⟹ **la boucle
> a lu ~40 à 06:06**. Le chemin d'écriture ne peut PAS perdre 122 lignes silencieusement.
>
> **Faille du raisonnement « synced today ⟹ pas de staleness » :** synced-today veut dire
> que la boucle a tourné et fini, PAS que l'amont rendait 162 à 06:06. Le job de scrape
> Omni-FI a approfondi mai/juin **après** 06:06 ; l'ingestion relit depuis la page 1 mais
> n'a pas été re-déclenchée depuis. Classique staleness.
>
> **Test discriminant read-only : `DIAGNOSTIC-dryrun-transactions.ts`** — rejoue
> lecture + `versLignePersistee` page par page, 0 écriture. Résultat attendu :
> `total_brutes == total_converties`, `exceptions == 0`, `date_max` en mai/juin
> ⟹ staleness confirmée. Si `converties < brutes` ou `exceptions > 0` ⟹ la conversion
> recale des lignes (bug à corriger, détail loggé par champ).
>
> **Confirmation définitive = re-sync réel de d23196 (ÉCRITURE, donc toi)** + relecture :
> attendu `created ≈ 122`, base 40 → 162, `date_max` avril → juin. Regarde le log
> `omnifi_sync_completed` (`created`/`updated`, `orchestration.ts` L544-558).
>
> **Écarté définitivement :** désalignement EndUser, cascade par compte, filtre
> `is_selected`, 403 avalé, collision clé unique, boucle de pagination.
>
> **Dette de robustesse (≠ cause) :** (a) une transaction DB **par page** — un throw sur
> une page laisse les pages committées avant ; (b) clé unique `transactions_cache` sans
> `bank_account_id`. À traiter, mais aucune n'explique le −122 ici.

# Diagnostic — "transactions manquantes" (PROD, 3 banques, 1 seul compte servi)

**But :** identifier pourquoi une seule connexion/un seul compte a reçu des
transactions alors que 3 vraies banques mauriciennes ont été connectées en prod
avec le bon EndUser. **Tout est read-only** — tu exécutes, l'agent n'a pas accès à
ta prod.

## Ce que l'ancienne hypothèse (désalignement EndUser) n'explique plus

Tu as prouvé que l'EndUser est bon : prod, 3 banques réelles, données réelles. Le
problème est donc ailleurs. Trois causes candidates, que le diagnostic sépare :

1. **Cascade par compte** (suspect n°1). Dans `orchestration.ts` (~L904-911), la
   boucle qui synchronise les comptes d'une connexion est **à l'intérieur** du
   `try/catch` de la connexion. Si le compte n°2 lève une erreur, le `catch`
   (~L912) marque **toute la connexion** en échec et **abandonne les comptes
   suivants** ; seuls les comptes déjà traités avant l'exception gardent leurs
   transactions.
2. **Comptes non sélectionnés.** L'ingestion ne prend que `is_selected = true`
   (consentement Account Selection). Un compte `is_selected = false` n'est **jamais
   tenté** — pas d'erreur, juste 0 transaction.
3. **Retour API vide.** `synchroniserCompte` marque `last_synced_at` **même si
   l'API a rendu 0 transaction**. Donc `last_synced_at` renseigné + 0 tx =
   « synchro techniquement OK, mais l'amont n'a rien renvoyé » (permission
   /transactions manquante côté banque, ou antériorité nulle).

## Étapes

1. Ouvre `DIAGNOSTIC-transactions-manquantes.sql` sur ta base **prod** (psql, ou la
   console SQL Neon).
2. **Étape 0** du script : repère la ligne de ton workspace prod, copie son
   `workspace_id`.
3. Colle ce UUID aux **3 endroits** marqués `00000000-...` (étapes 1, 2, 3).
4. Exécute étapes 1 → 2 → 3 **dans la même session** (l'étape 1 pose la RLS).
5. Renvoie-moi les résultats des étapes 2 et 3 (tu peux anonymiser les noms de
   compte, garde les colonnes techniques).

## Grille de lecture (étape 2, une ligne = un compte)

| `selectionne` | `derniere_synchro` | `nb_transactions` | Interprétation |
|---|---|---|---|
| `false` | (peu importe) | 0 | **Compte jamais ingéré** : consentement Account Selection ne l'a pas retenu → cause n°2. |
| `true` | `NULL` | 0 | **Compte jamais atteint** : la synchro s'est arrêtée avant lui → cascade (cause n°1) ou échec connexion en amont. |
| `true` | renseignée | 0 | **API muette** : synchro OK mais 0 tx renvoyée → cause n°3 (permission /transactions ou antériorité). |
| `true` | renseignée | > 0 | **OK** : le compte qui marche. |

Le motif attendu si c'est la **cascade** : sur une même banque, le 1er compte a des
tx + `derniere_synchro` renseignée, les comptes suivants ont `derniere_synchro =
NULL` et `statut_connexion` en échec.

## Étape 4 — Corréler avec les logs de synchro

Les échecs de connexion sont journalisés (sans PII) sous deux events. Cherche-les
dans les logs prod (Vercel / plateforme d'hébergement) sur la fenêtre de ta
synchro de ce matin :

```
omnifi_sync_connexion_echec          # échec dur d'une connexion (fail-soft)
omnifi_sync_connexion_a_reconnecter  # 403 désalignement / reconsentement requis
```

Chaque ligne porte `connectionId`, `code`, et pour une `OmniFiApiError` le `status`
HTTP + l'`obieCode`. Recoupe le `connectionId` avec `connexion_omnifi` de l'étape 2.

- **Un `omnifi_sync_connexion_echec` avec status 4xx/5xx sur la connexion des
  comptes muets** ⇒ confirme la cascade (cause n°1) : un compte a levé, la
  connexion a été abandonnée. On corrige en isolant chaque compte (voir plus bas).
- **Aucun event d'échec, mais des comptes `true`/synchro renseignée/0 tx** ⇒
  cause n°3 : l'API renvoie des pages vides. Prochain pas : sonde manuelle
  `/accounts/{omnifi_account_id}/transactions` (page 1) sur un compte muet pour
  voir si l'amont rend réellement 0, et sur quelle profondeur de dates.

## Le correctif probable (à décider APRÈS le diagnostic)

Si la cascade est confirmée : rendre la boucle par compte **résiliente** — un
`try/catch` autour de `synchroniserCompte` par compte, de sorte qu'un compte en
échec n'abandonne pas les comptes suivants de la même connexion (compté/loggé
individuellement, jamais propagé aux erreurs de tenancy qui, elles, doivent
continuer à re-lever). Chiffré en dette : `INGEST-RESILIENCE-COMPTE1` (voir
`CHANTIER-consignation.md`). On ne touche pas au code tant que le diagnostic n'a
pas tranché la cause.

## Antériorité (en cascade)

Si la cause est n°3 (API muette / peu de tx), la question « antériorité de la data »
se répond en même temps : la profondeur d'historique est celle que l'amont
`/transactions` accepte de paginer (pas de `/balances/history` ni de delta
`/transactions/sync` déployés — cf. `OMNIFI_API_FEEDBACK.md §10`). La colonne
`tx_plus_ancienne` de l'étape 2 te donne, compte par compte, la date la plus
ancienne effectivement récupérée aujourd'hui — c'est ton plancher d'antériorité
réel, à confronter à ce que la banque expose.
