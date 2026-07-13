/**
 * Bandeau récapitulatif de `/admin/entites` — L1 de `PLAN-refonte-entites.md`.
 *
 * Ce que l'écran ne disait pas : **combien il reste à faire**. Un compte « non assigné »
 * est INVISIBLE aux membres à accès restreint (fail-closed) — c'est donc le chiffre qui
 * gouverne l'écran, et il n'était affiché nulle part. On le met en tête, mis en avant.
 *
 * ZÉRO requête : les trois listes (entités avec leur `nbComptes` déjà agrégé, comptes,
 * membres) sont DÉJÀ lues par la page dans son unique `withWorkspace`. Tous les
 * compteurs se dérivent en mémoire.
 *
 * Le compte des « non assignés » vient de `compterNonAssignes` (regles-comptes.ts) — la
 * MÊME règle que le groupement du tableau. Les deux ne peuvent donc pas se contredire
 * (constat C1 des cross-reviews : un compte dont l'entité a été archivée est « non
 * assigné » à l'écran, tout en gardant son `entity_id` en base).
 *
 * Composant d'affichage PUR (aucun fetch, aucun état) : le conteneur RSC lui passe des
 * nombres déjà calculés. Tokens sémantiques uniquement. Texte en ANGLAIS (Q-LANG).
 */
import { cn } from "@/components/ui/states/primitives";

function Tuile({
  valeur,
  libelle,
  accent = false,
  toutRange = false,
}: {
  valeur: number;
  libelle: string;
  /** Met la tuile en avant : c'est le reste-à-faire, pas une statistique de plus. */
  accent?: boolean;
  /** `true` quand il ne reste rien à ranger → on rassure au lieu d'alerter. */
  toutRange?: boolean;
}) {
  const teinte = accent
    ? toutRange
      ? { fond: "bg-success-bg", texte: "text-success" }
      : { fond: "bg-warning-bg", texte: "text-warning" }
    : { fond: "bg-surface-inset", texte: "text-text-muted" };

  return (
    <div
      className={cn(
        "flex min-w-[120px] flex-col gap-0.5 rounded-control px-4 py-3",
        teinte.fond,
      )}
    >
      <span
        className={cn(
          "text-2xl font-semibold tabular-nums",
          accent ? teinte.texte : "text-ink",
        )}
      >
        {valeur}
      </span>
      <span className={cn("text-xs font-medium", teinte.texte)}>{libelle}</span>
    </div>
  );
}

export function BandeauRecap({
  nbEntites,
  nbComptes,
  nbNonAssignes,
  nbMembres,
}: {
  nbEntites: number;
  nbComptes: number;
  nbNonAssignes: number;
  nbMembres: number;
}) {
  // « Tout est rangé » n'a de sens que s'il y a QUELQUE CHOSE à ranger. Sans compte,
  // afficher un « 0 unassigned » vert féliciterait l'admin pour du néant — la tuile reste
  // donc neutre, et la phrase invite à connecter une banque (constat du Visual QA).
  const aDesComptes = nbComptes > 0;
  const toutRange = aDesComptes && nbNonAssignes === 0;
  const unSeul = nbNonAssignes === 1;

  return (
    <section
      aria-label="Summary"
      className="rounded-card border border-line bg-surface-card p-5 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Tuile
          valeur={nbEntites}
          libelle={nbEntites === 1 ? "entity" : "entities"}
        />
        <Tuile
          valeur={nbComptes}
          libelle={nbComptes === 1 ? "account" : "accounts"}
        />
        <Tuile
          valeur={nbNonAssignes}
          libelle="unassigned"
          // Sans compte, rien à alerter NI à célébrer : la tuile reste neutre.
          accent={aDesComptes}
          toutRange={toutRange}
        />
        <Tuile
          valeur={nbMembres}
          libelle={nbMembres === 1 ? "member" : "members"}
        />
      </div>

      {/* La phrase dit POURQUOI le chiffre compte — un nombre nu n'apprend rien à un
          directeur financier. `aria-live` : L2/L3 feront varier le compteur sans
          rechargement (assignation en masse, création d'entité). */}
      <p className="mt-3 text-sm text-text-muted" aria-live="polite">
        {!aDesComptes
          ? "No bank account yet. Connect a bank to start organising accounts into entities."
          : toutRange
            ? "Every account belongs to an entity. Members with restricted access can see all of them."
            : unSeul
              ? "1 account is not attached to any entity yet — it stays invisible to members with restricted access."
              : `${nbNonAssignes} accounts are not attached to any entity yet — they stay invisible to members with restricted access.`}
      </p>
    </section>
  );
}
