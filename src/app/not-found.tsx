import Link from "next/link";

/**
 * 404 applicative — remplace la page Next.js par défaut (anglaise, sans layout
 * ni retour possible : un utilisateur qui mord une URL périmée se retrouvait
 * face à « This page could not be found. » nu). Sobre, tokens Dodo, FR.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface-page px-6 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
        Erreur 404
      </p>
      <h1 className="mt-3 text-xl font-semibold text-text">
        Cette page n’existe pas
      </h1>
      <p className="mt-2 max-w-sm text-sm text-text-muted">
        L’adresse demandée ne correspond à aucune page de Dodo. Elle a peut-être
        été déplacée, ou le lien est périmé.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex h-10 items-center rounded-control bg-primary px-4 text-sm font-semibold text-text-onink transition-colors hover:bg-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        Retour au tableau de bord
      </Link>
    </main>
  );
}
