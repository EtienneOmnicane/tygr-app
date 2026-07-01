/**
 * Démo / Visual QA (Quality Gate 4) de l'interface d'assignation des entités aux
 * membres (cf. (workspace)/admin/entites/assignation-entites.tsx). NON destinée
 * à la production : isole le rendu du VRAI composant client `AssignationEntites`
 * hors auth/DB — la vraie page `/admin/entites` dépend du gating ADMIN
 * (withWorkspace) et redirige vers /login sans session.
 *
 * On monte le composant réel avec des PROPS FICTIVES (le composant est désormais
 * câblé : il reçoit entites + membres en props et poste sur la Server Action
 * `definirScopesAction`). ⚠️ Sur /demo (public, sans session), un clic
 * « Enregistrer » appelle la vraie action → elle exige une session workspace et
 * renverra donc une erreur : c'est ATTENDU. Cette page sert au rendu et à la
 * réactivité (bascule, cases, dirty state, garde-fou), pas à l'écriture.
 */
import {
  AssignationEntites,
  type EntiteVue,
  type MembreVue,
} from "@/app/(workspace)/admin/entites/assignation-entites";

export const metadata = { title: "Démo — Assignation des entités" };

const ENTITES_DEMO: EntiteVue[] = [
  { id: "ent-sucriere", nom: "Omnicane Sucrière", code: "SUC" },
  { id: "ent-energie", nom: "Omnicane Énergie", code: "ENE" },
  { id: "ent-hotellerie", nom: "Omnicane Hôtellerie", code: "HOT" },
  { id: "ent-immobilier", nom: "Omnicane Immobilier", code: "IMM" },
];

// scopeInitial : [] = Vision Globale (convention serveur) ; sinon entityIds.
const MEMBRES_DEMO: MembreVue[] = [
  {
    userId: "00000000-0000-4000-8000-000000000001",
    nomComplet: "Aïsha Ramnauth",
    email: "aisha.ramnauth@omnicane.mu",
    role: "ADMIN",
    scopeInitial: [], // Vision Globale
  },
  {
    userId: "00000000-0000-4000-8000-000000000002",
    nomComplet: "Jean-Claude Bissoondoyal",
    email: "jc.bissoondoyal@omnicane.mu",
    role: "MANAGER",
    scopeInitial: ["ent-sucriere", "ent-energie"],
  },
  {
    userId: "00000000-0000-4000-8000-000000000003",
    nomComplet: "Priya Goorah",
    email: "priya.goorah@omnicane.mu",
    role: "VIEWER",
    scopeInitial: ["ent-hotellerie"],
  },
];

export default function DemoAssignationEntites() {
  return (
    <div className="min-h-screen bg-surface-page">
      <p className="bg-surface-inset px-6 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
        Démo — assignation des entités{" "}
        <span className="font-normal normal-case">
          (composant câblé, props fictives · l’enregistrement n’aboutit pas hors
          session — c’est attendu)
        </span>
      </p>
      <main className="flex justify-center p-6">
        <div className="w-full max-w-3xl">
          <h1 className="mb-1 text-lg font-semibold">Assignation des entités</h1>
          <p className="mb-6 text-sm text-text-muted">
            Définissez le périmètre de chaque membre : accès à l’ensemble du
            groupe (Vision Globale) ou restreint à certaines entités (Vision
            Entité).
          </p>
          <AssignationEntites entites={ENTITES_DEMO} membres={MEMBRES_DEMO} />
        </div>
      </main>
    </div>
  );
}
