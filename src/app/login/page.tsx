/**
 * Écran de connexion Dodo (refonte : split-panel). Un utilisateur déjà
 * authentifié est renvoyé vers l'accueil (pas de double login).
 *
 * Gauche (≥ lg) : panneau de marque `primary` (bleu Lagoon) — logo + wordmark,
 * promesse produit, pied de page « Maurice / chiffrement ». Cercles décoratifs
 * (accent/ink/reef) en tokens, jamais de couleur en dur.
 * Droite : carte de connexion blanche (FormulaireConnexion inchangé côté logique).
 * Sous `lg` le panneau de marque se masque — le formulaire reste centré.
 */
import Image from "next/image";
import { redirect } from "next/navigation";

import {
  exigerSessionUtilisateur,
  NonAuthentifieError,
  ServiceIndisponibleError,
} from "@/server/auth/session";

import { FormulaireConnexion } from "./formulaire-connexion";

export const metadata = { title: "Connexion — Dodo" };

export default async function PageConnexion() {
  // Re-VALIDATION (pas un simple test de présence du cookie) — constat C1 de
  // la cross-review AUTH-MDP-TEMPO1 : une session invalidée par D4 (mot de
  // passe changé ailleurs) porte un JWT encore cryptographiquement valide ;
  // un `if (session?.userId) redirect("/")` bouclerait /login ↔ / sans jamais
  // montrer le formulaire (le cookie ne peut pas être effacé pendant un rendu
  // RSC). Ici : session VALIDE → accueil (ou forçage) ; périmée/absente →
  // formulaire (le signIn réussi écrasera le cookie périmé) ; base injoignable
  // → formulaire aussi (page publique — authorize refusera de toute façon).
  let compte: Awaited<ReturnType<typeof exigerSessionUtilisateur>> | null = null;
  try {
    compte = await exigerSessionUtilisateur();
  } catch (erreur) {
    if (
      !(erreur instanceof NonAuthentifieError) &&
      !(erreur instanceof ServiceIndisponibleError)
    ) {
      throw erreur;
    }
  }
  if (compte) {
    redirect(compte.mustChangePassword ? "/account/password" : "/");
  }

  return (
    <main className="flex min-h-screen flex-1">
      {/* Panneau de marque — masqué sous lg (le formulaire suffit alors). */}
      <section
        className="relative hidden w-[45%] flex-col justify-between overflow-hidden
          bg-primary p-12 text-text-onink lg:flex"
      >
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute -right-16 -top-20 size-72 rounded-full bg-accent/20" />
          <div className="absolute -bottom-24 -left-12 size-80 rounded-full bg-ink/25" />
          <div className="absolute bottom-28 right-16 size-24 rounded-full bg-surface-page/10" />
        </div>

        <div className="relative flex items-center gap-3">
          <Image
            src="/logo-dodo.png"
            alt=""
            width={46}
            height={53}
            className="rounded-control"
            priority
          />
          <span className="text-2xl font-extrabold tracking-tight">
            Dodo<span className="text-accent">.</span>
          </span>
        </div>

        <div className="relative">
          <h2 className="max-w-md text-3xl font-bold leading-tight">
            La trésorerie de votre groupe, en clair.
          </h2>
          <p className="mt-4 max-w-md text-primary-50">
            Soldes multi-devises, échéances et flux de vos entités mauriciennes,
            synchronisés depuis vos banques.
          </p>
        </div>

        <p className="relative text-sm text-primary-50">
          Conçu à l&apos;île Maurice · Données chiffrées de bout en bout
        </p>
      </section>

      {/* Panneau formulaire. */}
      <section className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <h1 className="text-lg font-semibold">
            Dodo<span className="text-accent">.</span>
          </h1>
          <p className="mt-1 mb-6 text-sm text-text-muted">
            Connectez-vous à votre espace de trésorerie.
          </p>
          <FormulaireConnexion />
        </div>
      </section>
    </main>
  );
}
