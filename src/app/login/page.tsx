/**
 * Écran de connexion. Un utilisateur déjà authentifié est renvoyé vers
 * l'accueil (pas de double login).
 */
import { redirect } from "next/navigation";

import { auth } from "@/auth";

import { FormulaireConnexion } from "./formulaire-connexion";

export const metadata = { title: "Connexion — TYGR" };

export default async function PageConnexion() {
  const session = await auth();
  if (session?.userId) {
    redirect("/");
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-card bg-surface-card p-8 shadow-card">
        <h1 className="text-lg font-semibold">
          TYGR<span className="text-accent">.</span>
        </h1>
        <p className="mt-1 mb-6 text-sm text-text-muted">
          Connectez-vous à votre espace de trésorerie.
        </p>
        <FormulaireConnexion />
      </div>
    </main>
  );
}
