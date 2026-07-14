/**
 * Matrice de la BARRE DE VUE par page (TOOLBAR-GLOBALE-CADRAGE1, lot A2 — validée par
 * Etienne le 2026-07-14, amendée le même jour sur /banques et /regles). Ces tests SONT
 * la matrice : ils la figent en CI.
 *
 * Trois familles :
 *  1. la matrice page par page (ce qui est monté où) ;
 *  2. la résolution par segment racine (sous-routes, normalisation, défaut) ;
 *  3. les GARDES issues de la cross-review — les deux qui comptent vraiment :
 *     - INVARIANT `perimetre: false` : n'est légitime que sur une surface dont la session
 *       est AMPUTÉE du viewFilter (`/admin/*`) ou hors workspace (`/selection`). Ailleurs,
 *       le filtre RLS continue de mordre → le masquer le rendrait invisible ET
 *       inannulable. Cette garde échoue si quelqu'un met `perimetre: false` sur une
 *       nouvelle page sans avoir amputé la session côté serveur.
 *     - COUVERTURE : toute route réelle de `src/app/(workspace)/` doit être une clé
 *       EXPLICITE de la matrice (une faute de frappe ferait tomber la page dans le
 *       défaut, en silence).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONFIG_DEFAUT,
  MATRICE_BARRE_VUE,
  toolbarConfig,
} from "@/components/shell/toolbar-config";

const COMPLETE = { periode: true, perimetre: true, cta: true, minimal: false };
const MINIMALE = { periode: false, perimetre: false, cta: false, minimal: true };
const AUCUNE = { periode: false, perimetre: false, cta: false, minimal: false };

/**
 * Les SEULS segments autorisés à masquer le sélecteur de périmètre (cf. invariant).
 *  - `admin`  : pages ET actions passent par `exigerSessionAdministration()` → session
 *               amputée du viewFilter (server/auth/session.ts) → aucun filtre ne mord.
 *  - `selection` : hors contexte workspace (aucun espace actif) → rien à filtrer.
 * ⚠️ N'AJOUTER un segment ici QU'APRÈS avoir amputé la session de la page côté serveur.
 */
const SEGMENTS_SANS_PERIMETRE_AUTORISES = ["admin", "selection"];

describe("toolbarConfig — matrice validée par page", () => {
  it("dashboard (/) : période + périmètre + CTA", () => {
    expect(toolbarConfig("/")).toEqual(COMPLETE);
  });

  it("/transactions : période + périmètre + CTA", () => {
    expect(toolbarConfig("/transactions")).toEqual(COMPLETE);
  });

  it("/graphiques : période + périmètre, PAS de CTA", () => {
    expect(toolbarConfig("/graphiques")).toEqual({
      periode: true,
      perimetre: true,
      cta: false,
      minimal: false,
    });
  });

  it("/echeances : périmètre seul (la période rétrospective n'a pas de sens sur un écran futur)", () => {
    expect(toolbarConfig("/echeances")).toEqual({
      periode: false,
      perimetre: true,
      cta: false,
      minimal: false,
    });
  });

  it("/banques : CTA + périmètre CONSERVÉ (le viewFilter mord encore : sync à 0 compte)", () => {
    expect(toolbarConfig("/banques")).toEqual({
      periode: false,
      perimetre: true,
      cta: true,
      minimal: false,
    });
  });

  it("/regles : périmètre CONSERVÉ (« Ré-analyser » ne traite que le périmètre filtré)", () => {
    expect(toolbarConfig("/regles")).toEqual({
      periode: false,
      perimetre: true,
      cta: false,
      minimal: false,
    });
  });

  it("/admin/membres : bande minimale (session amputée du viewFilter)", () => {
    expect(toolbarConfig("/admin/membres")).toEqual(MINIMALE);
  });

  it("/admin/entites : bande minimale", () => {
    expect(toolbarConfig("/admin/entites")).toEqual(MINIMALE);
  });

  it("/selection : AUCUNE barre (ni contrôle, ni bande de repère)", () => {
    expect(toolbarConfig("/selection")).toEqual(AUCUNE);
  });
});

describe("toolbarConfig — résolution par segment racine", () => {
  it("une sous-route hérite de la config de sa page mère", () => {
    expect(toolbarConfig("/transactions/tx-123")).toEqual(COMPLETE);
    expect(toolbarConfig("/banques/connexion-42/comptes")).toEqual(
      toolbarConfig("/banques"),
    );
  });

  it("tout /admin/* (y compris une sous-page future) reste minimal", () => {
    expect(toolbarConfig("/admin")).toEqual(MINIMALE);
    expect(toolbarConfig("/admin/futur-ecran")).toEqual(MINIMALE);
  });

  it("normalise le slash final, la query et le hash", () => {
    expect(toolbarConfig("/transactions/")).toEqual(COMPLETE);
    expect(toolbarConfig("/graphiques?periode=3m")).toEqual(
      toolbarConfig("/graphiques"),
    );
    expect(toolbarConfig("/regles#section")).toEqual(toolbarConfig("/regles"));
    // Chemin vide / racine nue → dashboard (segment racine "").
    expect(toolbarConfig("")).toEqual(COMPLETE);
    expect(toolbarConfig("/?periode=12m")).toEqual(COMPLETE);
  });

  it("une page NON cadrée retombe sur le défaut EXPLICITE : périmètre seul", () => {
    // FAIL-SAFE : le viewFilter suit l'utilisateur partout et mord sur toute page à
    // session complète → une page ajoutée sans toucher la matrice garde sa trappe de
    // sortie. La période, elle, est un no-op tant que la page ne lit pas `?periode`.
    expect(toolbarConfig("/nouvelle-page")).toEqual({
      periode: false,
      perimetre: true,
      cta: false,
      minimal: false,
    });
    expect(toolbarConfig("/demo/shell")).toEqual(CONFIG_DEFAUT);
  });
});

describe("toolbarConfig — gardes d'invariants (cross-review)", () => {
  const entrees = [
    ...Object.entries(MATRICE_BARRE_VUE),
    ["<défaut>", CONFIG_DEFAUT] as const,
  ];

  it("INVARIANT : masquer le périmètre n'est permis que sur une surface amputée du viewFilter", () => {
    for (const [segment, config] of entrees) {
      if (!config.perimetre) {
        expect(
          SEGMENTS_SANS_PERIMETRE_AUTORISES,
          `« ${segment} » masque le sélecteur de périmètre : le viewFilter y serait ` +
            `invisible ET inannulable. Ampute d'abord la session côté serveur ` +
            `(exigerSessionAdministration), puis ajoute ce segment à la liste.`,
        ).toContain(segment);
      }
    }
  });

  it("INVARIANT : minimal ⇒ aucun contrôle monté", () => {
    for (const [, config] of entrees) {
      if (config.minimal) {
        expect(config.periode || config.perimetre || config.cta).toBe(false);
      }
    }
  });

  it("seule /selection ne rend AUCUNE barre (pas de config muette par accident)", () => {
    // Une barre « vide » (0 contrôle + minimal:false) ne rend RIEN : c'est voulu pour
    // /selection, ce serait une page silencieusement sans chrome partout ailleurs.
    for (const [segment, config] of entrees) {
      const rienDuTout =
        !config.minimal && !config.periode && !config.perimetre && !config.cta;
      if (rienDuTout) expect(segment).toBe("selection");
    }
  });

  it("COUVERTURE : toute route de src/app/(workspace)/ est une clé explicite de la matrice", () => {
    const racine = join(process.cwd(), "src", "app", "(workspace)");
    const segments = readdirSync(racine, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      // Un route group `(dashboard)` n'apparaît PAS dans le pathname → segment "".
      .map((e) => (e.name.startsWith("(") ? "" : e.name));

    for (const segment of segments) {
      expect(
        Object.keys(MATRICE_BARRE_VUE),
        `La route « /${segment} » existe mais n'est pas cadrée : elle tomberait dans le ` +
          `défaut en SILENCE. Ajoute-la à MATRICE_BARRE_VUE.`,
      ).toContain(segment);
    }
  });
});
