/**
 * Démo — bandeau « vue restreinte » des surfaces d'administration (L0,
 * PLAN-refonte-entites.md §12).
 *
 * Pourquoi une route de démo : la vraie `/admin/entites` est gatée ADMIN
 * (`withWorkspace` → `notFound()` sans session ADMIN) et le bandeau ne s'affiche que
 * si `ctx.entityScope` / `ctx.accountScope` ≠ GLOBALE — un état qu'on ne peut pas
 * provoquer depuis un navigateur headless sans base. On monte donc le VRAI composant,
 * hors auth/DB, pour la capture Gate 4.
 *
 * Le composant est PUR (aucun fetch, aucun état) : ce qu'on voit ici est exactement ce
 * que rend la page quand l'ADMIN porte un périmètre en base.
 *
 * Hors production.
 */
import { AvertissementVueRestreinte } from "@/components/admin/avertissement-vue-restreinte";

export const metadata = { title: "Démo — Vue restreinte (admin)" };

export default function PageDemoVueRestreinte() {
  return (
    <main className="min-h-screen bg-surface-page p-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <header>
          <h1 className="text-lg font-semibold text-ink">
            Démo — bandeau « vue restreinte »
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            S’affiche en tête des écrans d’administration quand l’ADMIN porte un
            périmètre en base (<code>entity_scope</code> ou{" "}
            <code>account_scope</code> ≠ GLOBALE). L’écran DIT qu’il est partiel
            au lieu d’afficher des compteurs faux.
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            État : vue restreinte
          </h2>
          <AvertissementVueRestreinte />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            État : vue complète (nominal — le bandeau est absent du DOM)
          </h2>
          <p className="rounded-card border border-dashed border-line bg-surface-card p-6 text-center text-sm text-text-muted">
            Aucun bandeau : l’ADMIN voit l’intégralité du tenant.
          </p>
        </section>
      </div>
    </main>
  );
}
