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
 * Présentationnel : aucune donnée, aucune logique métier. « Banques » rejoint la
 * nav (la page /banques re-gate `peutModifier` côté serveur — cf. bank-cta).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { label: string; href: string };

const ITEMS: Item[] = [
  { label: "Dashboard", href: "/" },
  { label: "Transactions", href: "/transactions" },
  { label: "Échéances", href: "/echeances" },
  { label: "Graphiques", href: "/graphiques" },
  { label: "Banques", href: "/banques" },
  { label: "Règles", href: "/regles" },
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1 text-sm">
      {ITEMS.map((item) => {
        const actif =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
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
