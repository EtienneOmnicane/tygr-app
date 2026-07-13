/**
 * Démo — gestion des entités : créer / renommer / archiver (L2).
 *
 * On monte le VRAI composant hors auth/DB (la page réelle est gatée ADMIN → 404 sans
 * session). Un clic sur « Create » appelle la VRAIE Server Action, qui échoue sans
 * session : c'est justement le moyen de capturer l'état d'erreur de la modale.
 *
 * Ce que la démo doit prouver (Gate 4) :
 *   - une entité à 0 compte reste GÉRABLE (c'est tout l'objet de Q-ENTITE-VIDE : le
 *     tableau, lui, masque les groupes vides) ;
 *   - le bouton « Archive » est inerte tant que l'entité porte des comptes — archiver ne
 *     révoquerait aucun droit, le serveur refuse (EntiteNonVideError) ;
 *   - l'état vide (aucune entité) invite à en créer une.
 *
 * Hors production.
 */
import {
  GestionEntites,
  type EntiteGeree,
} from "@/app/(workspace)/admin/entites/gestion-entites";

export const metadata = { title: "Démo — Gestion des entités" };

const ENTITES: EntiteGeree[] = [
  { id: "11111111-1111-4111-8111-111111111111", nom: "Sucrière", code: "SUC", nbComptes: 12 },
  { id: "22222222-2222-4222-8222-222222222222", nom: "Énergie", code: "ENE", nbComptes: 5 },
  // Le cas qui motive tout le lot : entité VIDE → archivable, et surtout VISIBLE.
  { id: "33333333-3333-4333-8333-333333333333", nom: "Logistique", code: null, nbComptes: 0 },
];

export default function PageDemoGestionEntites() {
  return (
    <main className="min-h-screen bg-surface-page p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header>
          <h1 className="text-lg font-semibold text-ink">
            Démo — gestion des entités (L2)
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            « Logistique » porte 0 compte : elle reste visible et gérable — le
            tableau, lui, ne la rendrait pas (les groupes vides sont masqués).
            « Archive » est inerte sur les entités qui portent des comptes.
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            État 1 — peuplé (dont une entité vide)
          </h2>
          <GestionEntites entites={ENTITES} />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            État 2 — vide (aucune entité)
          </h2>
          <GestionEntites entites={[]} />
        </section>
      </div>
    </main>
  );
}
