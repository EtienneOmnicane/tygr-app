/**
 * EmptyState GÉNÉRIQUE et transverse (UI_GUIDELINES §4.4). Présentationnel pur :
 * aucune donnée, aucun fetch, aucun état. Le conteneur (page/feature) fournit le
 * contenu et décide du CTA.
 *
 * Conforme §4.4 « jamais un No data sec » : illustration outline + message
 * ergonomique + UN seul CTA (optionnel). Aucun vert/rouge ici (pas de donnée à
 * colorer, §3.1). Le CTA, quand présent, est un lien d'action `primary` (§2.3).
 *
 * Décisions design (plan-design-review 2026-06-17) :
 *   - D1 : chaque section passe SON `illustration` + SA micro-copy (pas de clone).
 *   - D2 : `cta` est OPTIONNEL — le conteneur ne le fournit que s'il pointe vers
 *     une action réellement utile (ex. « Connecter une banque » quand aucun
 *     compte n'est connecté). Pas de CTA creux vers une page non fonctionnelle.
 *
 * Diffère de `DashboardEmptyState` (couplé /banques) : celui-ci est neutre et
 * réutilisable. (TODO P2 : faire dériver DashboardEmptyState d'ici.)
 */
import Link from "next/link";

import {
  StateCard,
  StateIllustration,
  type StateIllustrationVariant,
} from "./primitives";

const CLASSE_CTA =
  "mt-6 inline-flex items-center gap-1.5 rounded-control px-3 py-2 text-sm " +
  "font-semibold text-primary transition-colors hover:text-primary-600 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
  "focus-visible:ring-offset-2";

export function EmptyState({
  title,
  message,
  illustration = "empty",
  cta,
  headingLevel = "h2",
}: {
  /** Titre court de l'état (ex. « Visualisez votre trésorerie »). */
  title: string;
  /** Message ergonomique décrivant la valeur à venir (§4.4). */
  message: string;
  /** Glyphe outline par section (D1). Défaut neutre `empty`. */
  illustration?: StateIllustrationVariant;
  /** CTA unique, OPTIONNEL (D2). Absent → message seul (pas de bouton creux). */
  cta?: { label: string; href: string };
  /**
   * Niveau du titre. `h1` quand l'EmptyState EST le contenu principal de la
   * page ; `h2` (défaut) quand il vit sous un `<h1>` existant.
   */
  headingLevel?: "h1" | "h2";
}) {
  const Heading = headingLevel;

  return (
    <StateCard className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <StateIllustration
        variant={illustration}
        className="mb-6 h-20 w-20 text-text-faint"
      />

      <Heading className="text-base font-semibold text-text">{title}</Heading>

      <p className="mt-2 max-w-md text-sm text-text-muted">{message}</p>

      {cta && (
        <Link href={cta.href} className={CLASSE_CTA}>
          <span aria-hidden>+</span>
          {cta.label}
        </Link>
      )}
    </StateCard>
  );
}
