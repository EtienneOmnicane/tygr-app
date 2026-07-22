/**
 * Écran de changement de mot de passe (AUTH-MDP-TEMPO1 D5) — HORS du groupe
 * `(workspace)` : le forçage précède même le choix d'un espace (/selection),
 * et l'utilisateur gaté ne doit RIEN voir du produit (pas de sidebar).
 * Le matcher du proxy ne l'exclut pas → cookie exigé, comme le reste.
 *
 * Deux visages (self-service assumé — la page reste accessible flag levé) :
 * - `must_change_password` VRAI → bandeau explicatif du forçage ;
 * - FAUX → lien retour vers le dashboard.
 *
 * Copie 100 % EN (Q-LANG) ; carte centrée calquée sur /selection et /login.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  exigerSessionUtilisateur,
  NonAuthentifieError,
} from "@/server/auth/session";

import { changerMotDePasseAction } from "./actions";
import { FormulaireMotDePasse } from "./formulaire-mot-de-passe";

export const metadata = { title: "Change password — Dodo" };

export default async function PageChangementMotDePasse() {
  // E6 + invalidation D4, SANS gate D3 : c'est LA surface autorisée au compte
  // gaté. Une session périmée est renvoyée au login (≡ non connecté).
  let compte: Awaited<ReturnType<typeof exigerSessionUtilisateur>>;
  try {
    compte = await exigerSessionUtilisateur();
  } catch (erreur) {
    if (erreur instanceof NonAuthentifieError) redirect("/login");
    throw erreur;
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-card bg-surface-card p-8 shadow-card">
        <h1 className="text-lg font-semibold">
          Dodo<span className="text-accent">.</span>
        </h1>
        <p className="mt-1 mb-6 text-sm text-text-muted">Change your password.</p>

        {compte.mustChangePassword ? (
          <div className="mb-6 rounded-control bg-surface-inset p-4">
            <p className="text-sm text-text-muted">
              Your password was set by an administrator. Choose a new one to
              continue — you will be the only person who knows it.
            </p>
          </div>
        ) : (
          <p className="mb-6 text-sm">
            <Link href="/" className="text-primary hover:underline">
              ← Back to dashboard
            </Link>
          </p>
        )}

        <FormulaireMotDePasse action={changerMotDePasseAction} />
      </div>
    </main>
  );
}
