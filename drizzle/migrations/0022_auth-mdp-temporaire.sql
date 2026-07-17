-- AUTH-MDP-TEMPO1 lot A (PLAN-auth-mdp-temporaire.md §3) — expand pur, backward-compatible N-1.
-- must_change_password : flag du mot de passe temporaire (D2).
-- password_changed_at : dernier posage de mot de passe ; NULL = jamais posé depuis cette migration (D4).
--
-- NB : le generate initial rejouait le contenu de 0020/0021 (SQL manuels sans snapshot,
-- diff calculé depuis 0019_snapshot). Fichier réduit aux 2 colonnes réellement nouvelles ;
-- le snapshot 0022 (complet, généré depuis schema.ts) redevient la baseline saine.
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;
