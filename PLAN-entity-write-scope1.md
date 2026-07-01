# Plan — ENTITY-WRITE-SCOPE1 (borner l'ÉCRITURE sur bank_accounts par scope entité)

> Phase IMPLÉMENTATION. Réfère `PLAN-entites-multi-tenant.md` (§2.2, §3.2) + dette
> TODOS `ENTITY-WRITE-SCOPE1`. Lève la **2ᵉ et dernière P1 du GATE d'activation
> Vision Entité**. Branche `fix/entity-write-scope` depuis `origin/main` (post #83).

## 1. Problème (prouvé runtime, test 14 de entites-isolation)

La policy `entity_scope` sur `bank_accounts` est `AS RESTRICTIVE FOR SELECT`. Elle
borne la LECTURE (#83) mais **PAS l'écriture**. Conséquence prouvée : un VIEWER scopé
Sucrière exécutant `UPDATE bank_accounts SET …` (sans WHERE) mute AUSSI les comptes
Énergie + non assigné ; un INSERT/UPDATE plaçant un compte hors de son scope réussit.
Trou d'**intégrité/autorisation** (pas de confidentialité — `RETURNING` reste borné au
SELECT, cf. test 14b conservé).

## 2. Décision de conception

**Remplacer la policy `FOR SELECT` par une policy `FOR ALL`**, même `USING` qu'avant +
un `WITH CHECK` portant **la même expression** que le `USING`.

- `FOR ALL` couvre SELECT / INSERT / UPDATE / DELETE en une policy.
- `USING` (SELECT/UPDATE/DELETE) : on ne peut cibler qu'une ligne in-scope → un membre
  scopé ne peut ni lire, ni UPDATE, ni DELETE un compte hors périmètre.
- `WITH CHECK` (INSERT/UPDATE) : l'état résultant doit être in-scope → impossible de
  **déplacer** un compte vers une entité hors scope, ni d'INSÉRER hors scope.
- Expression identique au SELECT actuel :
  ```
  nullif(current_setting('app.current_entity_scope', true), '') IS NULL   -- Vision Globale
  OR (entity_id IS NOT NULL AND entity_id = ANY(string_to_array(<guc>, ',')::uuid[]))
  ```

### Pourquoi cette expression ne régresse RIEN (pièges traités)

- **Ingestion (`upsertCompte`)** : INSERT `entity_id = NULL`. En **Vision Globale**
  (GUC vide) → `nullif(...) IS NULL` = TRUE → l'INSERT passe. L'ingestion tourne en
  Vision Globale (gardée `peutModifier`, MANAGER/ADMIN ; un ADMIN n'a pas de ligne
  `member_entity_scopes`). **Backward-compat code N-1** : aucun chemin Vision Entité
  n'existe en prod → policy neutre pour le code actuel. ✅
- **`onConflictDoUpdate` (upsertCompte)** : `set` **n'inclut pas** `entity_id` (invariant
  schema.ts:306). En Vision Globale, `WITH CHECK` TRUE → l'UPDATE de re-sync passe.
- **Sas d'assignation ADMIN** : repo `entites.ts` **pas encore livré** (L3/L4, bloqués
  par le GATE). Quand il le sera, l'ADMIN (Vision Globale) assignera sans gêne ; la garde
  `ctx.role === ADMIN` reste **applicative** (la RLS ignore le rôle, par design).
- **Cas fail-closed assumé** : un membre **scopé** (Vision Entité) qui déclencherait un
  sync → l'INSERT `entity_id=NULL` serait REFUSÉ. C'est le comportement voulu (un membre
  borné ne crée pas de comptes non-assignés, visibles du seul ADMIN). Documenté, non régressif
  (le sync est une opération d'admin de connexions, faite en Vision Globale).

## 3. Périmètre (anti-scope-creep, règle 7)

- **DANS cette PR** : migration 0009 (DROP + CREATE policy `FOR ALL`) + maj du commentaire
  0008 (référence croisée) + maj CLAUDE.md (la policy n'est plus « FOR SELECT seul ») +
  inversion des tests 14/14b → preuve que l'écriture hors scope est REFUSÉE + cochage
  TODOS (ENTITY-READ-JOIN1 résolu, ENTITY-WRITE-SCOPE1 résolu).
- **HORS périmètre** : pas de repo `entites.ts`, pas de garde ADMIN applicative, pas de
  durcissement de `categorisation.ts` (resterait à faire si la catégorisation devient
  scopée — mais elle masque déjà en lecture par la jointure #83). Ces points ne sont PAS
  ENTITY-WRITE-SCOPE1 (qui = « la policy ne borne pas l'écriture »).

## 4. Migration 0009 (expand, backward-compatible N-1)

```sql
DROP POLICY "entity_scope" ON "bank_accounts";
CREATE POLICY "entity_scope" ON "bank_accounts" AS RESTRICTIVE FOR ALL TO public
  USING (<expr>) WITH CHECK (<expr>);
```
- Pas de FORCE à re-poser (déjà sur bank_accounts via 0001/0003).
- Idempotence : `DROP POLICY` (sans IF EXISTS, la policy existe sur toute base ayant 0008).
- Le snapshot drizzle n'a pas à changer (policy custom hors modèle Drizzle, comme 0008).

## 5. Tests (inversion + non-régression)

`tests/isolation/entites-isolation.test.ts`, bloc « fuite latente écriture » :
- **Test 14 inversé** : VIEWER scopé Sucrière `UPDATE bank_accounts SET account_name=…`
  (sans WHERE) → ne mute QUE Sucrière ; Énergie + non assigné **inchangés** (USING borne).
- **Nouveau** : VIEWER scopé tentant de **déplacer** son compte vers Énergie
  (`SET entity_id = ENT_ENERGIE`) → refusé/0 ligne (WITH CHECK).
- **Test 14b** conservé/adapté : `RETURNING` borné au scope (déjà vrai).
- **Non-régression Vision Globale** : ADMIN assigne ACC_NONE → Énergie (test 12 existant) ;
  + nouveau : INSERT d'un compte `entity_id=NULL` en Vision Globale réussit (ingestion).
- Stop-loss : lint + typecheck + `npm test` (suite IDOR bloquante).

## 6. Ce que ça lève

GATE d'activation Vision Entité : `ENTITY-READ-JOIN1` (#83, lecture) + `ENTITY-WRITE-SCOPE1`
(cette PR, écriture) → **les deux P1 levées**. Reste possible APRÈS : livrer L3/L4
(repo entites.ts + Server Actions + garde ADMIN) puis L5 (preuve runtime bout-en-bout).
