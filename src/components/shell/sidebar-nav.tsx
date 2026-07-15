"use client";

/**
 * Navigation principale de la barre latérale (UI_GUIDELINES §1.2, refonte Dodo).
 * Client component : `usePathname` marque l'entrée active. La nav n'est plus une
 * barre horizontale sur `ink` mais une colonne verticale sur `surface-card`.
 *
 * État actif (mockup Dodo) : pilule `ink` pleine, texte `onink`, poids 700, PUCE
 * ambre (`accent`) — l'ambre signale la nav active, JAMAIS la donnée (§3.1). État
 * inactif : texte `text-muted`, fond transparent, survol `surface-inset`. La puce
 * reste présente mais transparente à l'inactif pour préserver l'alignement.
 *
 * PERSISTANCE DE LA PÉRIODE (TX/DASH-PERIODE-PERSIST1) : la période vit dans l'URL
 * (`?periode`/`?du`/`?au`, source unique — décision produit). Sans propagation, un clic de
 * nav la perdait (liens nus), alors que le périmètre (JWT, ambiant) survivait : l'asymétrie
 * qu'on corrige. On ré-injecte donc la période (whitelist stricte) dans l'href des SEULS
 * liens qui la LISENT (Dashboard, /transactions) via `hrefAvecPeriode`. Toute la décision
 * (quoi, où, comment) vit dans `nav-periode.ts` (pur, testé) ; ce composant la câble.
 *
 * ⚠️ `useSearchParams` force le bail-out CSR au prerender (Next 16) → la lecture des params
 * est isolée sous `<Suspense>` (même motif que `barre-vue.tsx`). Le fallback rend la nav aux
 * hrefs NUS (rendu serveur correct), qui basculent vers les hrefs porteurs de période à
 * l'hydratation — aucun saut de layout (seul le query de l'href change, invisible).
 *
 * Présentationnel : aucune donnée, aucune logique métier. « Banques » rejoint la
 * nav (la page /banques re-gate `peutModifier` côté serveur — cf. bank-cta).
 */
import { Suspense } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { estActifNav, hrefAvecPeriode } from "@/components/shell/nav-periode";

type Item = { label: string; href: string };

const ITEMS: Item[] = [
  { label: "Dashboard", href: "/" },
  { label: "Transactions", href: "/transactions" },
  { label: "Échéances", href: "/echeances" },
  { label: "Graphiques", href: "/graphiques" },
  { label: "Banques", href: "/banques" },
  { label: "Règles", href: "/regles" },
];

/**
 * Liste présentationnelle. `hrefParItem` transforme l'href NU d'un item en href de `<Link>`
 * (nu dans le fallback ; porteur de période sous `NavAvecPeriode`). ⚠️ L'état actif, lui, est
 * TOUJOURS calculé sur l'href NU (`estActifNav`) — jamais sur l'href porteur de query, sinon
 * `startsWith` échouerait et démarquerait la page active (piège du ticket).
 */
function NavListe({ hrefParItem }: { hrefParItem: (hrefNu: string) => string }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1 text-sm">
      {ITEMS.map((item) => {
        const actif = estActifNav(item.href, pathname);
        const href = hrefParItem(item.href);

        return (
          <Link
            key={item.href}
            href={href}
            aria-current={actif ? "page" : undefined}
            className={
              actif
                ? "flex items-center gap-2.5 rounded-control bg-ink px-3 py-2 font-bold text-text-onink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                : "flex items-center gap-2.5 rounded-control px-3 py-2 font-medium text-text-muted transition-colors hover:bg-surface-inset hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            }
          >
            <span
              aria-hidden
              className={
                actif
                  ? "size-1.5 shrink-0 rounded-full bg-accent"
                  : "size-1.5 shrink-0 rounded-full bg-transparent"
              }
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Lit la période courante (`useSearchParams`) et la propage dans l'href des liens éligibles. */
function NavAvecPeriode() {
  const searchParams = useSearchParams();
  return (
    <NavListe hrefParItem={(hrefNu) => hrefAvecPeriode(hrefNu, searchParams)} />
  );
}

export function SidebarNav() {
  // Fallback = nav aux hrefs NUS (usePathname n'exige PAS de Suspense, contrairement à
  // useSearchParams) : rendu serveur correct, bascule vers les hrefs porteurs de période
  // une fois `NavAvecPeriode` hydraté.
  return (
    <Suspense fallback={<NavListe hrefParItem={(hrefNu) => hrefNu} />}>
      <NavAvecPeriode />
    </Suspense>
  );
}
