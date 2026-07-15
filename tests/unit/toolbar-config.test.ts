/**
 * Matrice de la BARRE DE VUE par page (TOOLBAR-GLOBALE-CADRAGE1 lot A2, étendue par
 * TOOLBAR-DATE-PRECISE1 lot A1 — validée par Etienne le 2026-07-14). Ces tests SONT la
 * matrice : ils la figent en CI.
 *
 * Trois familles :
 *  1. la matrice page par page (ce qui est monté où) ;
 *  2. la résolution par segment racine (sous-routes, normalisation, défaut) ;
 *  3. les GARDES d'invariants — c'est ce qui compte vraiment :
 *     - INVARIANT `perimetre: false` : n'est légitime que sur une surface dont la session
 *       est AMPUTÉE du viewFilter (`/admin/*`) ou hors workspace (`/selection`). Ailleurs,
 *       le filtre RLS continue de mordre → le masquer le rendrait invisible ET
 *       inannulable. Cette garde échoue si quelqu'un met `perimetre: false` sur une
 *       nouvelle page sans avoir amputé la session côté serveur.
 *     - INVARIANT ANTI-MENSONGE (lot A1) : une page qui MONTE la période / la plage doit
 *       la LIRE (`resoudrePeriode(searchParams)`). Sans cette garde, A2 a livré DEUX
 *       PeriodeSwitcher qui ne filtraient rien (/graphiques et /transactions ont leur
 *       propre filtre IN-PAGE). Vérifiée en relisant le SOURCE des pages — mécanique, pas
 *       une consigne de vigilance.
 *     - INVARIANT `plageDates ⇒ periode` : la plage PRIME sur un preset ; sans le groupe
 *       de presets affiché, « primer » n'a pas de sens et il n'y a plus de retour arrière.
 *     - COUVERTURE : toute route réelle de `src/app/(workspace)/` doit être une clé
 *       EXPLICITE de la matrice (une faute de frappe ferait tomber la page dans le
 *       défaut, en silence).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONFIG_DEFAUT,
  MATRICE_BARRE_VUE,
  toolbarConfig,
} from "@/components/shell/toolbar-config";

/** Barre complète AVEC plage de dates — Dashboard ET /transactions (depuis A3). */
const COMPLETE = {
  periode: true,
  plageDates: true,
  perimetre: true,
  cta: true,
  minimal: false,
};
const MINIMALE = {
  periode: false,
  plageDates: false,
  perimetre: false,
  cta: false,
  minimal: true,
};
const AUCUNE = { ...MINIMALE, minimal: false };

const RACINE_WORKSPACE = join(process.cwd(), "src", "app", "(workspace)");

/**
 * Les SEULS segments autorisés à masquer le sélecteur de périmètre (cf. invariant).
 *  - `admin`  : pages ET actions passent par `exigerSessionAdministration()` → session
 *               amputée du viewFilter (server/auth/session.ts) → aucun filtre ne mord.
 *  - `selection` : hors contexte workspace (aucun espace actif) → rien à filtrer.
 * ⚠️ N'AJOUTER un segment ici QU'APRÈS avoir amputé la session de la page côté serveur.
 */
const SEGMENTS_SANS_PERIMETRE_AUTORISES = ["admin", "selection"];

/**
 * EXEMPTIONS de la garde anti-mensonge — liste FERMÉE, nommée et datée.
 *
 * VIDE depuis A3 (TX-TOOLBAR-DEDUP1, 2026-07-15). `transactions` en était l'unique
 * entrée : la matrice y montait `periode: true` alors que la page ne lisait PAS `?periode`
 * (ses bornes de date vivaient IN-PAGE). A3 a retiré les dates in-page et câblé la page sur
 * `resoudrePeriode(await searchParams)` → l'exemption est LEVÉE, la garde s'applique
 * pleinement à `transactions`.
 *
 * ⚠️ NE JAMAIS rallonger cette liste. Toute entrée est l'aveu qu'on affiche un contrôle
 * qui ne filtre rien (mensonge d'affichage) : la revue doit la refuser — on câble la page
 * (`resoudrePeriode`), ou on retire le contrôle de la matrice.
 */
const SEGMENTS_PERIODE_NON_CABLEE: string[] = [];

/**
 * Chemin de la `page.tsx` d'un segment de la matrice. Le segment "" est le dashboard, qui
 * vit dans un ROUTE GROUP (`(dashboard)`) — invisible dans le pathname : on le retrouve en
 * cherchant le groupe qui porte une `page.tsx` (aucun chemin en dur à maintenir).
 */
/**
 * Retire commentaires de bloc et de ligne. La garde anti-mensonge cherche un APPEL, pas une
 * mention : sans ce dépouillement, un fichier qui se contente de PARLER de `resoudrePeriode`
 * dans sa doc passerait la garde tout en n'appelant rien (trou relevé en cross-review).
 */
function sansCommentaires(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function fichierPage(segment: string): string | null {
  if (segment === "") {
    const groupes = readdirSync(RACINE_WORKSPACE, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("("))
      .map((e) => join(RACINE_WORKSPACE, e.name, "page.tsx"));
    return groupes.find((p) => existsSync(p)) ?? null;
  }
  const chemin = join(RACINE_WORKSPACE, segment, "page.tsx");
  return existsSync(chemin) ? chemin : null;
}

describe("toolbarConfig — matrice validée par page", () => {
  it("dashboard (/) : période + PLAGE DE DATES + périmètre + CTA", () => {
    expect(toolbarConfig("/")).toEqual(COMPLETE);
  });

  it("/transactions : période + PLAGE + périmètre + CTA (barre globale = source unique, A3)", () => {
    // A3 (TX-TOOLBAR-DEDUP1) : dates in-page retirées, la page LIT la fenêtre globale
    // (resoudrePeriode) → même config complète que le Dashboard.
    expect(toolbarConfig("/transactions")).toEqual(COMPLETE);
  });

  it("/graphiques : périmètre SEUL — période RETIRÉE (la page ne lit pas ?periode)", () => {
    // ≠ matrice A2 (arbitrage Etienne 2026-07-14) : `graphiques/page.tsx` ne prend même
    // pas `searchParams` — son PeriodeSwitcher ne filtrait RIEN (le vrai filtre est le
    // segmenté in-page). Retrait = zéro régression. Unification → GRAPHIQUES-PERIODE-DEDUP1.
    expect(toolbarConfig("/graphiques")).toEqual({
      periode: false,
      plageDates: false,
      perimetre: true,
      cta: false,
      minimal: false,
    });
  });

  it("/echeances : périmètre seul (la période rétrospective n'a pas de sens sur un écran futur)", () => {
    expect(toolbarConfig("/echeances")).toEqual({
      periode: false,
      plageDates: false,
      perimetre: true,
      cta: false,
      minimal: false,
    });
  });

  it("/banques : CTA + périmètre CONSERVÉ (le viewFilter mord encore : sync à 0 compte)", () => {
    expect(toolbarConfig("/banques")).toEqual({
      periode: false,
      plageDates: false,
      perimetre: true,
      cta: true,
      minimal: false,
    });
  });

  it("/regles : périmètre CONSERVÉ (« Ré-analyser » ne traite que le périmètre filtré)", () => {
    expect(toolbarConfig("/regles")).toEqual({
      periode: false,
      plageDates: false,
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
    expect(toolbarConfig("/?du=2026-03-03&au=2026-04-17")).toEqual(COMPLETE);
  });

  it("une page NON cadrée retombe sur le défaut EXPLICITE : périmètre seul", () => {
    // FAIL-SAFE : le viewFilter suit l'utilisateur partout et mord sur toute page à
    // session complète → une page ajoutée sans toucher la matrice garde sa trappe de
    // sortie. La période, elle, est un no-op tant que la page ne lit pas `?periode`.
    expect(toolbarConfig("/nouvelle-page")).toEqual({
      periode: false,
      plageDates: false,
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
        expect(
          config.periode || config.plageDates || config.perimetre || config.cta,
        ).toBe(false);
      }
    }
  });

  it("INVARIANT ANTI-MENSONGE : une page qui MONTE la période/plage DOIT la LIRE", () => {
    // LA garde du lot A1. Un contrôle de période affiché sur une page qui n'appelle pas
    // `resoudrePeriode(searchParams)` est un NO-OP : l'utilisateur croit borner sa vue, la
    // page ignore le réglage. C'est le défaut qu'A2 a livré sur /graphiques et
    // /transactions — invisible parce qu'AUCUN test ne reliait la matrice au code serveur.
    // On relit donc le SOURCE de la page : mécanique, pas déclaratif.
    for (const [segment, config] of Object.entries(MATRICE_BARRE_VUE)) {
      if (!config.periode && !config.plageDates) continue;
      if (SEGMENTS_PERIODE_NON_CABLEE.includes(segment)) continue;

      const chemin = fichierPage(segment);
      expect(
        chemin,
        `« ${segment} » monte un contrôle de période mais n'a pas de page.tsx trouvable.`,
      ).not.toBeNull();

      // On dépouille les COMMENTAIRES d'abord : sans ça, une simple mention du mot
      // « resoudrePeriode » dans un bloc de doc suffisait à faire passer la garde.
      const source = sansCommentaires(readFileSync(chemin!, "utf8"));

      expect(
        source,
        `« /${segment} » MONTE la période (ou la plage) mais sa page n'APPELLE pas ` +
          `resoudrePeriode(...) : le contrôle ne filtrerait RIEN. Câble la page, ou passe ` +
          `periode/plageDates à false dans la matrice.`,
      ).toMatch(/\bresoudrePeriode\s*\(/);

      expect(
        source,
        `« /${segment} » n'accepte pas de searchParams : elle ne peut pas lire ?periode.`,
      ).toContain("searchParams");

      // Pour une page à PLAGE : l'appel doit recevoir les searchParams ENTIERS, pas un objet
      // littéral qui cueillerait `{ periode }` seul — ça typecheckerait (tous les champs de
      // ParamsPeriode sont optionnels) tout en IGNORANT ?du/?au. Ce serait le mensonge exact
      // que cette garde existe pour rendre impossible.
      if (config.plageDates) {
        expect(
          source,
          `« /${segment} » monte la PLAGE mais passe un objet littéral à resoudrePeriode : ` +
            `?du/?au seraient ignorés. Passe les searchParams entiers.`,
        ).not.toMatch(/resoudrePeriode\s*\(\s*\{/);
      }
    }
  });

  it("INVARIANT : plageDates ⇒ periode (une plage PRIME sur un preset — encore faut-il l'afficher)", () => {
    for (const [segment, config] of entrees) {
      if (config.plageDates) {
        expect(
          config.periode,
          `« ${segment} » monte la plage de dates sans les presets : « primer sur le ` +
            `preset » n'a alors aucun sens, et l'utilisateur perd le retour arrière en un clic.`,
        ).toBe(true);
      }
    }
  });

  it("seule /selection ne rend AUCUNE barre (pas de config muette par accident)", () => {
    // Une barre « vide » (0 contrôle + minimal:false) ne rend RIEN : c'est voulu pour
    // /selection, ce serait une page silencieusement sans chrome partout ailleurs.
    for (const [segment, config] of entrees) {
      const rienDuTout =
        !config.minimal &&
        !config.periode &&
        !config.plageDates &&
        !config.perimetre &&
        !config.cta;
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
