/**
 * Bandeau « vue restreinte » des surfaces d'ADMINISTRATION — L0 de
 * `PLAN-refonte-entites.md` (§12, garde fail-safe).
 *
 * Une surface d'administration porte sur le TENANT ENTIER. Deux mécanismes peuvent
 * pourtant la réduire, et ils n'ont pas la même parade :
 *
 * 1. `view_filter` (JWT, sélecteur de périmètre du header) — **neutralisé** en amont par
 *    `exigerSessionAdministration()` : la session est amputée, le GUC n'est pas posé.
 * 2. `entity_scope` / `account_scope` (résolus EN BASE depuis `member_entity_scopes` /
 *    `user_scopes`) — **PAS neutralisables** par la session. Or rien n'interdit aujourd'hui
 *    de scoper un ADMIN : `definirScopesMembre` ne vérifie que la MEMBERSHIP, jamais le
 *    RÔLE. Un ADMIN scopé lit donc des listes partielles, sans le savoir.
 *
 * Ce composant couvre le cas 2. Il ne CORRIGE rien — il **refuse de mentir** : mieux vaut
 * dire « votre vue est partielle » qu'afficher un « 0 compte non assigné » rassurant et
 * faux (le compteur du récap est le reste-à-faire de l'écran : s'il ment, l'écran ment).
 * Le durcissement serveur (interdire de scoper un ADMIN) est une décision ouverte — §12.
 *
 * Pur et isomorphe (zéro fetch, zéro état) : le conteneur RSC lui passe le booléen déjà
 * résolu depuis `ctx.entityScope` / `ctx.accountScope`.
 *
 * Tokens : `warning` (avertissement système, pas une donnée) + fond + icône + message —
 * jamais une couleur seule (UI_GUIDELINES §3.4 « erreur ≠ sortie » ; ici avertissement ≠
 * montant sortant). Texte en ANGLAIS : décision Q-LANG (aucune nouvelle copie FR).
 */
import { cn } from "@/components/ui/states/primitives";

export function AvertissementVueRestreinte({
  className,
}: {
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-card border border-warning/30 bg-warning-bg p-4",
        className,
      )}
    >
      <svg
        aria-hidden
        viewBox="0 0 20 20"
        className="mt-0.5 size-5 shrink-0 text-warning"
      >
        <path
          d="M10 6.5v4.25M10 13.9v.05"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <path
          d="M8.68 2.98a1.5 1.5 0 0 1 2.64 0l6.1 11.29A1.5 1.5 0 0 1 16.1 16.5H3.9a1.5 1.5 0 0 1-1.32-2.23z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>

      <div className="min-w-0">
        <p className="text-sm font-semibold text-warning">Restricted view</p>
        <p className="mt-0.5 text-sm text-text-muted">
          Your access is limited to part of this group, so the counts and lists
          below only cover the accounts within your scope — not the whole
          workspace. Ask another administrator to lift the restriction before
          relying on these figures.
        </p>
      </div>
    </div>
  );
}
