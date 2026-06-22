/**
 * Démo / Visual QA (Quality Gate 4) de l'interface d'assignation des entités aux
 * membres (cf. (workspace)/admin/entites/assignation-entites.tsx). NON destinée
 * à la production : isole le rendu du VRAI composant client `AssignationEntites`
 * hors auth/DB — la vraie page `/admin/entites` dépend du gating ADMIN
 * (withWorkspace) et redirige vers /login sans session.
 *
 * On monte le composant réel (pas une reconstitution) : ce qui est validé ici
 * (réactivité Vision Globale / Vision Entité, cases, dirty state, recherche) est
 * exactement ce que verra l'ADMIN. Le composant est entièrement mocké (tableaux
 * en dur), donc aucune donnée réelle n'est requise.
 */
import { AssignationEntites } from "@/app/(workspace)/admin/entites/assignation-entites";

export const metadata = { title: "Démo — Assignation des entités" };

export default function DemoAssignationEntites() {
  return (
    <div className="min-h-screen bg-surface-page">
      <p className="bg-surface-inset px-6 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
        Maquette — assignation des entités{" "}
        <span className="font-normal normal-case">
          (composant réel, données mockées · la vraie page exige un rôle ADMIN)
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
          <AssignationEntites />
        </div>
      </main>
    </div>
  );
}
