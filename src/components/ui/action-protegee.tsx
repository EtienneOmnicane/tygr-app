/**
 * `ActionProtegee` — convention unique de gating des actions par rôle
 * (plan D2 décision #37, PLAN-epic1-auth-consent.md §4.2).
 *
 * LA convention, à ne jamais mélanger :
 * - **Action de MODIFICATION** (synchroniser, connecter une banque, modifier une
 *   échéance) → reste VISIBLE mais INERTE, avec un tooltip qui explique pourquoi.
 *   Cacher l'action priverait le VIEWER de l'information « cette capacité existe,
 *   demandez-la à votre manager ».
 * - **Surface d'ADMINISTRATION** (membres, entités, journal d'audit) → ABSENTE du
 *   DOM pour un non-ADMIN (pas grisée). Ce composant ne sert PAS à ça : on ne monte
 *   simplement pas la surface (cf. `app-sidebar.tsx`, `transactions/page.tsx`).
 *
 * Pur et isomorphe : zéro fetch, zéro état, aucun accès au rôle — le conteneur
 * (RSC ou feature) lui passe `autorise`, déjà résolu par `peutModifier(ctx.role)`.
 * La frontière d'autorité RÉELLE reste serveur (repositories + Server Actions, sous
 * le `ctx.role` re-résolu par withWorkspace à chaque requête) ; ce composant ne fait
 * que traduire une décision déjà prise en capacité d'interface.
 *
 * Accessibilité — `aria-disabled`, JAMAIS `disabled` nu : un élément `disabled` sort
 * du parcours de tabulation, donc son `title` devient inatteignable au clavier et le
 * VIEWER n'apprend jamais pourquoi l'action est inerte. On garde donc l'élément
 * focusable et on neutralise l'interaction (pas de `href`, pas de `onClick`).
 */
import { cn } from "@/components/ui/states/primitives";

/** Message par défaut (registre S2 — cohérent sur toutes les surfaces). */
export const MESSAGE_LECTURE_SEULE =
  "Votre rôle (lecture seule) ne permet pas cette action.";

/**
 * Identifiant stable dérivé de la raison — pas de `useId` (qui imposerait
 * `"use client"` à une primitive purement présentationnelle). Deux actions qui
 * partagent la même raison pointent la même description : c'est valide en ARIA
 * (`aria-describedby` référence un id, plusieurs éléments peuvent le référencer),
 * et ça évite de dupliquer N fois le même texte pour un lecteur d'écran.
 */
function idDescription(raison: string): string {
  let hash = 0;
  for (let i = 0; i < raison.length; i++) {
    hash = (hash * 31 + raison.charCodeAt(i)) | 0;
  }
  return `raison-protegee-${(hash >>> 0).toString(36)}`;
}

/**
 * Description lue par les lecteurs d'écran. `title` seul ne suffit PAS : VoiceOver
 * et NVDA l'ignorent souvent, et il est inatteignable au tactile. On pose donc un
 * `aria-describedby` vers ce texte `sr-only`, ET on garde `title` pour l'infobulle
 * au survol souris. Les deux se complètent (constat de cross-review, 2026-07-10).
 */
function RaisonAccessible({ id, raison }: { id: string; raison: string }) {
  return (
    <span id={id} className="sr-only">
      {raison}
    </span>
  );
}

export function ActionProtegee({
  autorise,
  children,
  raison = MESSAGE_LECTURE_SEULE,
  className,
}: {
  /** Résultat de `peutModifier(role)`. Le composant ne lit jamais le rôle lui-même. */
  autorise: boolean;
  /** L'action réelle (bouton, lien) — montée telle quelle si `autorise`. */
  children: React.ReactNode;
  /** Ce que le tooltip explique. Doit dire POURQUOI, pas seulement « interdit ». */
  raison?: string;
  /** Classes du repli inerte (le gabarit doit rester celui de l'action). */
  className?: string;
}) {
  if (autorise) {
    return <>{children}</>;
  }

  const idRaison = idDescription(raison);

  return (
    <>
      <span
        aria-disabled
        aria-describedby={idRaison}
        title={raison}
        className={cn(
          "inline-flex cursor-default items-center gap-1.5 text-text-faint",
          className,
        )}
      >
        {children}
      </span>
      {/* FRÈRE, jamais enfant : un `sr-only` à l'intérieur serait agrégé au nom
          accessible de l'élément (« Modifier Votre rôle… »). */}
      <RaisonAccessible id={idRaison} raison={raison} />
    </>
  );
}

/**
 * Variante « bouton » : rend un `<button>` réellement inerte quand `autorise` est
 * faux, tout en restant focusable (cf. note d'accessibilité ci-dessus). À préférer
 * quand l'enfant est un bouton d'action inline (liste d'échéances, tableaux).
 */
export function BoutonProtege({
  autorise,
  raison = MESSAGE_LECTURE_SEULE,
  onClick,
  children,
  className,
  disabled = false,
  ...rest
}: {
  autorise: boolean;
  raison?: string;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
  /** Désactivation MÉTIER (ex. suppression en cours) — orthogonale au rôle. */
  disabled?: boolean;
} & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick" | "disabled" | "className"
>) {
  const inerte = !autorise;
  const idRaison = idDescription(raison);

  return (
    <>
      <button
        type="button"
        // Le rôle rend INERTE (aria-disabled, focusable) ; le métier rend DÉSACTIVÉ
        // (disabled, hors tabulation) — deux mécanismes distincts, jamais confondus.
        aria-disabled={inerte || undefined}
        // `aria-describedby` porte la raison de façon FIABLE aux lecteurs d'écran ;
        // `title` ne fait qu'ajouter l'infobulle souris (souvent ignorée par
        // VoiceOver/NVDA et inatteignable au tactile).
        aria-describedby={inerte ? idRaison : undefined}
        disabled={disabled}
        title={inerte ? raison : undefined}
        onClick={inerte ? undefined : onClick}
        className={cn(
          className,
          inerte && "cursor-default text-text-faint hover:bg-transparent",
        )}
        {...rest}
      >
        {children}
      </button>
      {/* FRÈRE du bouton : à l'intérieur, il polluerait son nom accessible. */}
      {inerte && <RaisonAccessible id={idRaison} raison={raison} />}
    </>
  );
}
