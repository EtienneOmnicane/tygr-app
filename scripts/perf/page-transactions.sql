-- ════════════════════════════════════════════════════════════════════════════
-- PERF-KEYSET-INDEX-RLS1 — harnais de mesure
--
-- Reproduit à l'identique le contexte d'exécution de `withWorkspace` :
--   • rôle applicatif `tygr_app` (non-owner, pas de BYPASSRLS → la RLS mord)
--   • GUC `app.current_workspace_id` + `app.current_user_id`
--   • Vision Globale : `app.current_account_scope` / `app.current_view_filter`
--     NON posés (cf. tenancy.ts — clause account_scope alors neutre)
--
-- Les requêtes sont dérivées ligne à ligne de `listerTransactions`
-- (src/server/repositories/transactions.ts) : mêmes FROM/JOIN/WHERE/ORDER/LIMIT.
-- Seule la projection est reprise telle quelle (sans effet sur le plan).
--
-- EMPLOI :
--   docker exec -i tygr_postgres psql -U tygr_owner -d tygr -f - < scripts/perf/page-transactions.sql
--
-- ⚠️ Sans `SET ROLE tygr_app` NI les GUC, la RLS ne mord pas et les plans mesurés
--    sont FAUX (l'estimateur évalue alors le prédicat tenant à NULL → rows=1, ce qui
--    fait croire à tort que ce prédicat est « opaque »). Cf.
--    docs/PERF-KEYSET-INDEX-RLS1-mesures.md §2.
-- ⚠️ La base locale est VIVANTE : toute comparaison avant/après doit être APPARIÉE
--    (rejouer les deux dos à dos), jamais deux passes séparées.
-- ════════════════════════════════════════════════════════════════════════════

\set QUIET on
\timing off
\pset pager off

-- Le workspace est résolu depuis la base (le plus peuplé) : aucun UUID en dur, le
-- harnais reste valable sur une base réinitialisée.
SELECT set_config('app.current_workspace_id',
       (select t.workspace_id::text from transactions_cache t
        group by t.workspace_id order by count(*) desc limit 1), false);
SELECT set_config('app.current_user_id', (SELECT user_id::text FROM workspace_members LIMIT 1), false);
SET ROLE tygr_app;

\set QUIET off

\echo '════════ Q1 — résolution de PAGE seule (étage 1, page 1, sans filtre) ════════'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
select tc.id, tc.transaction_date, tc.bank_account_id, ba.account_name, bc.institution_name,
       tc.amount, tc.currency, tc.credit_debit, tc.clean_label, tc.bank_label_raw,
       tc.primary_category, tc.sub_category, tc.is_auto_categorized, tc.category_source,
       tc.confidence_level, tc.classification_source
from transactions_cache tc
inner join bank_accounts ba on tc.bank_account_id = ba.id
inner join bank_connections bc on ba.connection_id = bc.id
where tc.is_removed = false
order by tc.transaction_date desc, tc.id desc
limit 51;

\echo '════════ Q2 — requête COMPLÈTE (étage 1 + LATERAL), page 1, sans filtre ════════'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
select page.id, page.transaction_date, page.amount,
       coalesce(agg.nb_splits, 0) as nb_splits,
       coalesce(agg.montant_ventile, 0)::text as montant_ventile,
       case
         when coalesce(agg.nb_splits, 0) = 0 then 'NON_CATEGORISE'
         when coalesce(agg.montant_ventile, 0) >= abs(page.amount) then 'COMPLET'
         else 'PARTIEL'
       end as statut,
       agg.cat_dominante_id, agg.cat_dominante_nom
from (
  select tc.id, tc.transaction_date, tc.bank_account_id, ba.account_name, bc.institution_name,
         tc.amount, tc.currency, tc.credit_debit, tc.clean_label, tc.bank_label_raw,
         tc.primary_category, tc.sub_category, tc.is_auto_categorized, tc.category_source,
         tc.confidence_level, tc.classification_source
  from transactions_cache tc
  inner join bank_accounts ba on tc.bank_account_id = ba.id
  inner join bank_connections bc on ba.connection_id = bc.id
  where tc.is_removed = false
  order by tc.transaction_date desc, tc.id desc
  limit 51
) page
left join lateral (
  select count(*)::int as nb_splits,
         coalesce(sum(z.amount), 0)::numeric as montant_ventile,
         (array_agg(z.category_id order by z.amount desc, cat.name asc, z.category_id asc))[1] as cat_dominante_id,
         (array_agg(cat.name      order by z.amount desc, cat.name asc, z.category_id asc))[1] as cat_dominante_nom
  from transaction_categorizations z
  join categories cat on cat.id = z.category_id
  where z.transaction_id = page.id
    and z.transaction_date = page.transaction_date
) agg on true
order by page.transaction_date desc, page.id desc;

\echo '════════ Q3 — chemin ?statut=COMPLET ════════'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
select tc.id, tc.transaction_date, tc.amount
from transactions_cache tc
inner join bank_accounts ba on tc.bank_account_id = ba.id
inner join bank_connections bc on ba.connection_id = bc.id
where tc.is_removed = false
  and exists (select 1 from transaction_categorizations z
              where z.transaction_id = tc.id and z.transaction_date = tc.transaction_date)
  and (select coalesce(sum(z.amount), 0) from transaction_categorizations z
       where z.transaction_id = tc.id and z.transaction_date = tc.transaction_date) >= abs(tc.amount)
order by tc.transaction_date desc, tc.id desc
limit 51;

\echo '════════ Q4 — chemin ?statut=NON_CATEGORISE ════════'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
select tc.id, tc.transaction_date, tc.amount
from transactions_cache tc
inner join bank_accounts ba on tc.bank_account_id = ba.id
inner join bank_connections bc on ba.connection_id = bc.id
where tc.is_removed = false
  and not exists (select 1 from transaction_categorizations z
                  where z.transaction_id = tc.id and z.transaction_date = tc.transaction_date)
order by tc.transaction_date desc, tc.id desc
limit 51;

\echo '════════ Q5 — chemin ?statut=PARTIEL ════════'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
select tc.id, tc.transaction_date, tc.amount
from transactions_cache tc
inner join bank_accounts ba on tc.bank_account_id = ba.id
inner join bank_connections bc on ba.connection_id = bc.id
where tc.is_removed = false
  and exists (select 1 from transaction_categorizations z
              where z.transaction_id = tc.id and z.transaction_date = tc.transaction_date)
  and (select coalesce(sum(z.amount), 0) from transaction_categorizations z
       where z.transaction_id = tc.id and z.transaction_date = tc.transaction_date) < abs(tc.amount)
order by tc.transaction_date desc, tc.id desc
limit 51;

\echo '════════ Q6 — page 2 (curseur keyset) ════════'
EXPLAIN (ANALYZE, BUFFERS, COSTS)
select tc.id, tc.transaction_date, tc.amount
from transactions_cache tc
inner join bank_accounts ba on tc.bank_account_id = ba.id
inner join bank_connections bc on ba.connection_id = bc.id
where tc.is_removed = false
  and (tc.transaction_date, tc.id) < (date '2026-07-01', '00000000-0000-0000-0000-000000000000'::uuid)
order by tc.transaction_date desc, tc.id desc
limit 51;
