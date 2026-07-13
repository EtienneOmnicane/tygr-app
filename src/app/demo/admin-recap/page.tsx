/**
 * Démo — bandeau récapitulatif de `/admin/entites` (L1, PLAN-refonte-entites.md).
 *
 * La vraie page est gatée ADMIN (404 sans session) : on monte donc le VRAI composant,
 * hors auth/DB, pour la capture Gate 4. Il est PUR (aucun fetch, aucun état) → ce qu'on
 * voit ici est exactement ce que rend la page.
 *
 * Les TROIS états de la surface (checklist UI_GUIDELINES §6.5) :
 *   1. reste-à-faire  — des comptes ne sont rattachés à aucune entité (le cas réel :
 *                       77 sur 87). C'est le chiffre qui gouverne l'écran.
 *   2. tout rangé     — plus rien à faire ; on rassure au lieu d'alerter.
 *   3. vide           — aucune banque connectée ; le bandeau n'alerte pas sur du néant.
 *
 * Hors production.
 */
import { BandeauRecap } from "@/app/(workspace)/admin/entites/bandeau-recap";

export const metadata = { title: "Démo — Récap admin entités" };

function Cas({
  titre,
  children,
}: {
  titre: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {titre}
      </h2>
      {children}
    </section>
  );
}

export default function PageDemoRecap() {
  return (
    <main className="min-h-screen bg-surface-page p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header>
          <h1 className="text-lg font-semibold text-ink">
            Démo — bandeau récapitulatif (/admin/entites)
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Le chiffre « unassigned » est le reste-à-faire de l’écran : un compte
            non assigné est invisible aux membres à accès restreint.
          </p>
        </header>

        <Cas titre="État 1 — reste-à-faire (le cas réel : 77 comptes sur 87)">
          <BandeauRecap
            nbEntites={4}
            nbComptes={87}
            nbNonAssignes={77}
            nbMembres={6}
          />
        </Cas>

        <Cas titre="État 2 — tout est rangé (0 non assigné)">
          <BandeauRecap
            nbEntites={4}
            nbComptes={87}
            nbNonAssignes={0}
            nbMembres={6}
          />
        </Cas>

        <Cas titre="État 3 — vide (aucune banque connectée)">
          <BandeauRecap
            nbEntites={0}
            nbComptes={0}
            nbNonAssignes={0}
            nbMembres={1}
          />
        </Cas>

        <Cas titre="Cas limite — singuliers (1 entité · 1 compte · 1 membre)">
          <BandeauRecap
            nbEntites={1}
            nbComptes={1}
            nbNonAssignes={1}
            nbMembres={1}
          />
        </Cas>
      </div>
    </main>
  );
}
