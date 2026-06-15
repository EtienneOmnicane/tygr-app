"use client";

/**
 * Navigation principale du header (UI_GUIDELINES §1.2). Client component : a
 * besoin de `usePathname` pour marquer l'onglet actif (soulignement `accent`,
 * §1.2 — l'accent ambre signale la nav active, JAMAIS la donnée, §3.1).
 *
 * Présentationnel : aucune donnée, aucune logique métier. Les liens pointent
 * vers les segments du groupe (workspace) ; les sections non encore livrées
 * (Graphiques, Échéances, Transactions) sont des placeholders inertes — elles
 * arriveront avec leurs epics, le shell est neutre vis-à-vis de leur contenu.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = {
  label: string;
  href: string;
  /** Section pas encore livrée → rendue inerte (pas de navigation morte). */
  placeholder?: boolean;
};

const ITEMS: Item[] = [
  { label: "Dashboard", href: "/" },
  { label: "Graphiques", href: "/graphiques", placeholder: true },
  { label: "Échéances", href: "/echeances", placeholder: true },
  { label: "Transactions", href: "/transactions", placeholder: true },
];

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-6 text-sm font-medium">
      {ITEMS.map((item) => {
        const actif = item.href === "/"
          ? pathname === "/"
          : pathname.startsWith(item.href);

        // Placeholder : libellé estompé, non cliquable (évite un lien mort).
        if (item.placeholder) {
          return (
            <span
              key={item.href}
              aria-disabled
              className="cursor-default text-text-onink/60"
            >
              {item.label}
            </span>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={actif ? "page" : undefined}
            className={
              actif
                ? "relative pb-1 text-text-onink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                : "text-text-onink/60 transition-colors hover:text-text-onink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            }
          >
            {item.label}
            {actif && (
              <span
                aria-hidden
                className="absolute inset-x-0 -bottom-[18px] h-1 rounded-[2px] bg-accent"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
