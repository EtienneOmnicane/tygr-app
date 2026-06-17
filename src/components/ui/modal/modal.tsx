"use client";

/**
 * Modal — primitive de modale TRANSVERSE (UI_GUIDELINES §4.4). Première modale du
 * design system ; réutilisée par CategoryManagerModal, SplitAllocationModal et le
 * futur RulesBuilder. Centralise overlay, fermeture, focus, accessibilité — pas
 * de duplication de ce markup à chaque modale (DRY).
 *
 * §4.4 : overlay `rgba(15,30,61,0.48)`, titre uppercase centré (+0.04em), croix
 * en haut à droite, Escape + clic-overlay ferment — SAUF surface destructive
 * (`dismissible={false}`) qui exige une action explicite (révocation, etc.).
 *
 * A11y : `role="dialog"` + `aria-modal`, focus envoyé au panneau à l'ouverture,
 * focus-trap basique (Tab cyclique), restauration du focus à la fermeture.
 * Présentationnel : le contenu et les actions (pied) sont fournis par l'appelant.
 *
 * Pas de dépendance externe (radix/headlessui non installés, règle 9) : portail
 * natif (`createPortal`), gestion clavier maison.
 */
import {
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Largeurs §2.2 : 480px formulaire simple, 720px tableaux de règles. */
const LARGEURS = {
  sm: "max-w-[480px]",
  lg: "max-w-[720px]",
} as const;

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "sm",
  dismissible = true,
}: {
  open: boolean;
  /** Fermeture demandée (croix, Escape, clic-overlay). No-op si `dismissible=false`. */
  onClose: () => void;
  /** Titre (rendu uppercase centré, §4.4). */
  title: string;
  children: ReactNode;
  /** Pied d'actions (boutons). Optionnel. */
  footer?: ReactNode;
  size?: keyof typeof LARGEURS;
  /** false = surface destructive : Escape/overlay ne ferment pas (action explicite). */
  dismissible?: boolean;
}) {
  const panneauRef = useRef<HTMLDivElement>(null);
  const dernierFocusRef = useRef<HTMLElement | null>(null);

  const fermerSiPermis = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  // Focus : mémorise l'élément actif, envoie le focus au panneau, restaure à la fermeture.
  useEffect(() => {
    if (!open) return;
    dernierFocusRef.current = document.activeElement as HTMLElement | null;
    panneauRef.current?.focus();
    return () => dernierFocusRef.current?.focus?.();
  }, [open]);

  // Escape + focus-trap (Tab cyclique dans le panneau).
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        fermerSiPermis();
        return;
      }
      if (e.key === "Tab" && panneauRef.current) {
        const focusables = panneauRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const premier = focusables[0];
        const dernier = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === premier) {
          e.preventDefault();
          dernier.focus();
        } else if (!e.shiftKey && document.activeElement === dernier) {
          e.preventDefault();
          premier.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, fermerSiPermis]);

  // Verrouille le scroll de l'arrière-plan pendant l'ouverture.
  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      // Overlay §4.4 : rgba(15,30,61,0.48). Clic hors panneau ferme (si permis).
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,30,61,0.48)] p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) fermerSiPermis();
      }}
    >
      <div
        ref={panneauRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          "w-full rounded-modal bg-surface-card shadow-modal focus:outline-none",
          LARGEURS[size],
        )}
      >
        {/* En-tête : titre uppercase centré + croix (§4.4) */}
        <div className="relative flex items-center justify-center border-b border-line px-8 py-5">
          <h2 className="text-[15px] font-semibold uppercase tracking-[0.04em] text-text">
            {title}
          </h2>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Fermer"
              className="absolute right-5 top-1/2 -translate-y-1/2 rounded-control p-1
                text-text-muted transition-colors hover:text-text
                focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span aria-hidden className="text-lg leading-none">×</span>
            </button>
          )}
        </div>

        {/* Corps (§2.2 : padding 32px) */}
        <div className="px-8 py-6">{children}</div>

        {/* Pied d'actions optionnel */}
        {footer && (
          <div className="flex items-center justify-center gap-3 border-t border-line px-8 py-5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
