-- ════════════════════════════════════════════════════════════════════════════
-- ENTITY-PARTIES-SCOPE1 — périmètre d'ÉTAGE 2 sur `account_party_role` (RLS
-- native). Plan de référence : PLAN-entity-parties-scope.md (décisions D1/D2/D3
-- tranchées le 2026-07-21).
--
-- ┌─ CE QUE CETTE MIGRATION FERME (et ce qu'elle ne ferme PAS) ────────────────┐
-- │ Elle ne corrige AUCUNE fuite active : les 4 chemins de lecture recensés     │
-- │ (plan §1.2) sont tous bornés — 3 par une jointure DEPUIS bank_accounts, le  │
-- │ 4e (résolveur) délibérément. Elle ajoute la défense COMPLÉMENTAIRE qui      │
-- │ manquait : jusqu'ici le périmètre d'étage 2 de cette table tenait à 100 %   │
-- │ sur une CONVENTION DE CODE (ENTITY-READ-JOIN1) — une garantie SYNTAXIQUE    │
-- │ (la forme de chaque requête), qui se re-vérifie à chaque requête écrite et  │
-- │ n'échoue JAMAIS bruyamment si on l'oublie. Mode de défaillance concret :    │
-- │ un `from(accountPartyRole).leftJoin(bankAccounts, …)` — indiscernable au    │
-- │ lint d'un `from(bankAccounts).leftJoin(accountPartyRole, …)` — laisse       │
-- │ sortir les lignes hors périmètre, sans erreur ni test rouge. Après cette    │
-- │ migration, la base ferme ce chemin quelle que soit la forme de la requête.  │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ RÉOUVERTURE ASSUMÉE D'UNE DÉCISION TRACÉE (règle 10) ─────────────────────┐
-- │ 0017 (bloc COEXISTENCE) et schema.ts:936-937 disaient explicitement que le  │
-- │ scope de cette table « s'hérite ICI par JOINTURE sur bank_accounts — jamais │
-- │ une policy séparée ». Ce n'était donc PAS un oubli de 0017, et cette        │
-- │ migration ne se présente pas comme un correctif de bug. On rouvre en citant │
-- │ la décision + le FAIT NOUVEAU (plan §1.3) : deux lectures DIRECTES et sans  │
-- │ jointure existent déjà sur la table SŒUR `parties`                          │
-- │ (entites.ts:605-624, user-scopes.ts:224-233), prouvant que la convention de │
-- │ jointure n'est pas structurellement tenue. La RLS mord sur TOUT accès (psql │
-- │ d'incident, script de migration de données, job Inngest, `tygr_service`) —  │
-- │ une règle de lint ne couvre que le TypeScript (plan §2.2).                  │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ D1 — CALQUE 0017 (`account_scope`), PAS 0009 (`entity_scope`) ────────────┐
-- │ Le ticket d'origine proposait « entity_scope calquée sur 0009 ». Écarté :   │
-- │ depuis 0016/0017 le résolveur UNIFIE déjà l'axe entité en comptes           │
-- │ (tenancy.ts:334-345 traduit member_entity_scopes → bank_accounts.id). Une   │
-- │ `entity_scope` transitive serait à la fois REDONDANTE (l'axe entité est     │
-- │ couvert par account_scope) et INSUFFISANTE : elle raterait l'axe            │
-- │ `user_scopes` de type COMPTE et TOUTE la clause `view_filter`.              │
-- │                                                                             │
-- │ FORME DIRECTE (§2.1 forme i) : `account_party_role` porte `bank_account_id  │
-- │ NOT NULL` en dur (schema.ts:945) → prédicat direct, réplique caractère pour │
-- │ caractère de 0017 sur `balance_history`. On n'utilise PAS un EXISTS vers    │
-- │ bank_accounts (forme ii) : inutilement coûteux quand la colonne est là, et  │
-- │ il imbriquerait une évaluation RLS sur bank_accounts (2 policies            │
-- │ RESTRICTIVE). Le prédicat est indexé par                                    │
-- │ `account_party_role_workspace_account_idx` (schema.ts:983-986).             │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ AS RESTRICTIVE FOR ALL — USING == WITH CHECK (identique à 0016/0017) ─────┐
-- │ RESTRICTIVE ⇒ se combine en AND avec `tenant_isolation` (PERMISSIVE) :      │
-- │ accès ⟺ tenant ET périmètre. Une PERMISSIVE par erreur s'OR'erait avec      │
-- │ tenant_isolation et ne filtrerait RIEN — pire, elle CASSERAIT AUSSI         │
-- │ l'étage 1 : le OR rendrait vrai le prédicat pour un membre d'un AUTRE       │
-- │ tenant dont le GUC de périmètre n'est pas posé (fuite cross-client).        │
-- │ Vérifié par mutation : le cas 2/WS_B rougit, pas seulement les cas de       │
-- │ périmètre. C'est l'erreur la plus coûteuse et la plus invisible du lot.     │
-- │ FOR ALL ⇒ borne LECTURE (USING) ET ÉCRITURE (WITH CHECK) : un INSERT de     │
-- │ détention visant un compte hors périmètre est refusé — l'IDOR ne se déplace │
-- │ pas vers l'écriture (piège historique : 0009 était FOR SELECT alors que ses │
-- │ tests prouvaient FOR ALL → faux vert pendant tout un lot ; mutation n°5).   │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ BACKWARD-COMPATIBILITÉ CODE N-1 (règle 9, expand-contract) ───────────────┐
-- │ Migration de POLICY PURE : aucun changement de schéma, aucune donnée        │
-- │ touchée, aucune colonne ajoutée ou retirée → le code N-1 tourne inchangé.   │
-- │ INGESTION (ingestion.ts:373-385, upsert de détention) : elle tourne en      │
-- │ VISION GLOBALE — le résolveur ne pose AUCUN GUC d'étage 2 quand le membre   │
-- │ n'a aucune ligne de scope (tenancy.ts:301-307, cas (a)) → les deux clauses  │
-- │ court-circuitent sur `nullif(...) IS NULL` = TRUE → INSERT et               │
-- │ `onConflictDoUpdate` passent inchangés. Zéro régression d'ingestion,        │
-- │ prouvé par le cas 5 de la suite (garde anti-fail-closed).                   │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ AUTO-RÉFÉRENCE DU RÉSOLVEUR — le point dur à ne PAS rater (plan §5) ──────┐
-- │ tenancy.ts:319-327 lit CETTE TABLE pour RÉSOUDRE le droit d'un membre scopé │
-- │ par PARTY. Poser une policy dessus crée donc une auto-référence POTENTIELLE.│
-- │ C'est sûr AUJOURD'HUI, et pour une raison précise et fragile : la           │
-- │ résolution (:310-345) se fait AVANT la pose des GUC (:349-374) — ordre      │
-- │ documenté comme intentionnel en :246-251. La lecture voit l'état tenant     │
-- │ BRUT.                                                                       │
-- │ SI L'ORDRE EST UN JOUR INVERSÉ (refactor, extraction de helper,             │
-- │ réordonnancement « pour poser les GUC au plus tôt ») : un membre scopé par  │
-- │ PARTY ne verrait plus les lignes qui DÉFINISSENT SON PROPRE DROIT →         │
-- │ accountsAutorises = ∅ → sentinelle UUID-nul (:370-372) → il ne voit PLUS    │
-- │ RIEN. Fail-closed (aucune fuite) mais DÉNI D'ACCÈS TOTAL ET SILENCIEUX :    │
-- │ dashboard vide, aucune erreur. Le commentaire ci-dessus n'échouera jamais ; │
-- │ la seule défense mécanique est le CAS 10 de la suite d'isolation (membre    │
-- │ scopé par PARTY). Ne pas le supprimer en croyant qu'il fait doublon.        │
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- HORS PÉRIMÈTRE, explicitement (plan §6) :
--   • `parties` — décision D2 : ses 2 lectures directes sont ADMIN-only STRICT,
--     chaîne prouvée maillon par maillon (peutAdministrer = `role === "ADMIN"`,
--     permissions.ts:19-21 ; exigerAdmin, entites.ts:390-391 ; et AUCUN chemin
--     d'UPDATE de rôle n'existe dans l'app — provisioning.ts:132-140 est un
--     INSERT `onConflictDoNothing`, donc le contournement classique « membre
--     scopé PUIS promu ADMIN » n'est pas atteignable). Classé P2 rattaché à un
--     chantier NOMMÉ (TODOS.md) : la première surface titulaire ouverte à un
--     rôle non-ADMIN. Le cas 9 de la suite est la CONTRE-PREUVE volontaire que
--     `parties` reste visible hors périmètre — à INVERSER le jour du P2.
--   • `user_scopes` — AUCUNE policy de périmètre, et c'est CORRECT : c'est la
--     table de DROITS qui DÉFINIT le périmètre ; la scoper par lui-même serait
--     une auto-référence circulaire. Y en poser une « par symétrie » serait un
--     DÉFAUT, pas un correctif (plan §2.3).
--   • `tygr_app.sql` NON TOUCHÉ : `account_party_role` est déjà en liste blanche
--     DELETE (ligne 150, table de LIAISON éditable, NON append-only). Une policy
--     RLS et un privilège DELETE sont deux défenses ORTHOGONALES : ajouter l'une
--     n'octroie ni ne retire l'autre. Aucune table append-only n'entre en liste.
--
-- PARTITIONNEMENT : sans objet. `account_party_role` n'est PAS partitionnée → le
-- piège « RLS non héritée par les partitions » (0017 DÉCISION C) ne s'applique
-- pas, et AUCUNE clause de roulement annuel n'est à ajouter au runbook.
--
-- drizzle-kit n'émet PAS les policies au GUC custom (constant 0001/0003/0008/
-- 0014/0016/0017) → migration ÉCRITE À LA MAIN. Idempotente (DROP IF EXISTS +
-- CREATE), donc re-jouable.
--
-- ROLLBACK : `DROP POLICY IF EXISTS "account_scope" ON "account_party_role";`
-- → retour exact à l'état 0023. Aucune donnée touchée (migration de policy pure).
-- ════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "account_scope" ON "account_party_role";--> statement-breakpoint
CREATE POLICY "account_scope" ON "account_party_role" AS RESTRICTIVE FOR ALL TO public
  USING (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  )
  WITH CHECK (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  );
