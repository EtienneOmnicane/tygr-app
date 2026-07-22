/**
 * Tests de la frontière anti-OPEN-REDIRECT du chemin de retour (A4 /
 * PERIMETRE-REDIRECT-PAGE1). Le champ `origine` est posté par le PerimetreSwitcher :
 * il vient du navigateur, donc un attaquant peut le forger. Cette suite FIGE le
 * contrat fail-closed — tout ce qui n'est pas PROUVÉ interne renvoie `null`, et
 * l'appelant retombe sur "/" (le comportement d'avant le correctif).
 *
 * Ne pas confondre avec `redirect-origin.test.ts` : celui-là couvre l'origine
 * EXTERNE de la cible postMessage du widget Omni-FI (allowlist + https). Ici, on
 * n'accepte QUE de l'interne et on ne rend JAMAIS d'origine.
 *
 * ⚠️ Les caractères de contrôle sont écrits en ÉCHAPPEMENTS (\r, \n, \t) ou
 * construits par String.fromCharCode — JAMAIS en littéral : un caractère invisible
 * dans une fixture est intestable en revue.
 */
import { describe, expect, it } from "vitest";

import {
  CHEMIN_INTERNE_LONGUEUR_MAX,
  validerCheminInterne,
} from "@/lib/redirect-interne";

describe("validerCheminInterne — chemins internes acceptés", () => {
  it("racine", () => {
    expect(validerCheminInterne("/")).toBe("/");
  });

  it("chemin simple", () => {
    expect(validerCheminInterne("/transactions")).toBe("/transactions");
  });

  it("PRÉSERVE la query (?periode=3m) — sinon la période sauterait au retour", () => {
    expect(validerCheminInterne("/transactions?periode=3m")).toBe(
      "/transactions?periode=3m",
    );
  });

  it("préserve une query à plusieurs paramètres", () => {
    expect(validerCheminInterne("/graphiques?periode=12m&vue=categorie")).toBe(
      "/graphiques?periode=12m&vue=categorie",
    );
  });

  it("chemin imbriqué (admin)", () => {
    expect(validerCheminInterne("/admin/entites")).toBe("/admin/entites");
  });

  it("RETIRE le hash (non transmis au serveur, rien à faire dans la destination)", () => {
    expect(validerCheminInterne("/transactions#ligne-42")).toBe("/transactions");
    expect(validerCheminInterne("/transactions?periode=3m#x")).toBe(
      "/transactions?periode=3m",
    );
  });

  it("un segment encodé exotique reste INTERNE (au pire un 404 chez nous, jamais une fuite)", () => {
    // `%2F%2Fevil.example` est un SEGMENT encodé, PAS une URL protocol-relative :
    // il résout sur notre propre origine. On l'accepte — pas d'allowlist de routes,
    // elle casserait silencieusement chaque nouvelle page (repli "/" = le bug qu'on
    // corrige).
    expect(validerCheminInterne("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example");
  });

  it("espace final : NORMALISÉ par le parseur, reste interne (pas un vecteur)", () => {
    // Vérifié : le parseur WHATWG retire les espaces de tête/queue → la sortie est un
    // chemin interne propre. On FIGE ce comportement pour qu'un durcissement futur
    // (rejet) soit un choix conscient et non un effet de bord.
    expect(validerCheminInterne("/transactions ")).toBe("/transactions");
    // En TÊTE, la règle « commence par / » mord AVANT le parseur → rejet.
    expect(validerCheminInterne(" /transactions")).toBeNull();
  });

  it("à la borne exacte de longueur (accepté)", () => {
    const limite = "/" + "a".repeat(CHEMIN_INTERNE_LONGUEUR_MAX - 1);
    expect(limite.length).toBe(CHEMIN_INTERNE_LONGUEUR_MAX);
    expect(validerCheminInterne(limite)).toBe(limite);
  });
});

describe("validerCheminInterne — rejets (open-redirect)", () => {
  it("URL protocol-relative //host → null (LE piège classique)", () => {
    expect(validerCheminInterne("//evil.example")).toBeNull();
    expect(validerCheminInterne("//evil.example/phishing")).toBeNull();
    expect(validerCheminInterne("///evil.example")).toBeNull();
  });

  it("DOT-SEGMENTS → //host après normalisation → null (contournement cross-review 2026-07-14)", () => {
    // ⚠️ Régression fermée par la règle 7 (re-validation de la SORTIE). Avant elle,
    // ces entrées franchissaient les gardes d'ENTRÉE (elles ne commencent pas par
    // `//`, pas d'antislash, origine sentinelle préservée) mais le parseur normalise
    // les `..`/`.` en un pathname `//evil.example` → open-redirect protocol-relative.
    // Prouvé de bout en bout dans Next 16.2.9 (Location suivi vers https://evil.example/).
    expect(validerCheminInterne("/..//evil.example")).toBeNull();
    expect(validerCheminInterne("/.//evil.example")).toBeNull();
    expect(validerCheminInterne("/foo/..//evil.example")).toBeNull();
    expect(validerCheminInterne("/a/../..//evil.example")).toBeNull();
    expect(validerCheminInterne("/../../..//evil.example")).toBeNull();
    expect(validerCheminInterne("/..///evil.example")).toBeNull();
    expect(validerCheminInterne("/..//evil.example/login?next=x")).toBeNull();
    // `%2e%2e` est décodé en `..` par le parseur → même effondrement.
    expect(validerCheminInterne("/%2e%2e//evil.example")).toBeNull();
    expect(validerCheminInterne("/%2E%2E//evil.example")).toBeNull();
  });

  it("antislash /\\host → null", () => {
    // Vérifié empiriquement : `new URL("/\\evil.example", base).origin` vaut
    // `https://evil.example` — les parseurs WHATWG normalisent `\` en `/` pour les
    // schémas spéciaux. C'est donc un VRAI vecteur, pas une précaution théorique : la
    // règle « pas d'antislash » le tue, et la comparaison d'origine le rattraperait
    // de toute façon (deux gardes indépendantes).
    expect(validerCheminInterne("/\\evil.example")).toBeNull();
    expect(validerCheminInterne("/\\/evil.example")).toBeNull();
    expect(validerCheminInterne("\\/evil.example")).toBeNull();
    expect(validerCheminInterne("\\\\evil.example")).toBeNull();
    // Antislash même au milieu : jamais légitime dans un chemin interne.
    expect(validerCheminInterne("/transactions\\..\\x")).toBeNull();
  });

  it("URL absolue à schéma → null (y compris notre propre hôte : on ne rend que du relatif)", () => {
    expect(validerCheminInterne("https://evil.example")).toBeNull();
    expect(validerCheminInterne("https://evil.example/transactions")).toBeNull();
    expect(validerCheminInterne("http://evil.example")).toBeNull();
    expect(validerCheminInterne("https://app.tygr.mu/transactions")).toBeNull();
    // Astuce « userinfo » : l'hôte réel est evil.example, pas app.tygr.mu.
    expect(validerCheminInterne("https://app.tygr.mu@evil.example/")).toBeNull();
  });

  it("schémas dangereux → null", () => {
    expect(validerCheminInterne("javascript:alert(1)")).toBeNull();
    expect(validerCheminInterne("JaVaScRiPt:alert(1)")).toBeNull();
    expect(validerCheminInterne("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(validerCheminInterne("vbscript:msgbox(1)")).toBeNull();
  });

  it("chemin RELATIF → null (on n'accepte que l'absolu interne)", () => {
    expect(validerCheminInterne("transactions")).toBeNull();
    expect(validerCheminInterne("./transactions")).toBeNull();
    expect(validerCheminInterne("../admin/entites")).toBeNull();
    expect(validerCheminInterne("?periode=3m")).toBeNull();
    expect(validerCheminInterne("#ancre")).toBeNull();
  });

  it("CRLF / caractères de contrôle → null (injection d'en-tête Location)", () => {
    expect(validerCheminInterne("/transactions\r\nSet-Cookie: a=b")).toBeNull();
    expect(validerCheminInterne("/transactions\n")).toBeNull();
    expect(validerCheminInterne("/transactions\r")).toBeNull();
    expect(validerCheminInterne("/\t/evil.example")).toBeNull();
    // NUL / US / DEL : construits par CODE (aucun littéral invisible en source).
    for (const code of [0x00, 0x1f, 0x7f]) {
      const chemin = `/transactions${String.fromCharCode(code)}`;
      expect(validerCheminInterne(chemin)).toBeNull();
    }
  });

  it("valeur non-string (champ absent, File trafiqué) → null", () => {
    expect(validerCheminInterne(null)).toBeNull();
    expect(validerCheminInterne(undefined)).toBeNull();
    expect(validerCheminInterne(42)).toBeNull();
    expect(validerCheminInterne(["/transactions"])).toBeNull();
    expect(validerCheminInterne({ pathname: "/transactions" })).toBeNull();
    // Cas réel : `formData.get("origine")` rend un `File` si le champ est trafiqué.
    expect(validerCheminInterne(new File(["x"], "f.txt"))).toBeNull();
  });

  it("chaîne vide → null", () => {
    expect(validerCheminInterne("")).toBeNull();
  });

  it("trop long (> borne) → null", () => {
    const trop = "/" + "a".repeat(CHEMIN_INTERNE_LONGUEUR_MAX);
    expect(trop.length).toBe(CHEMIN_INTERNE_LONGUEUR_MAX + 1);
    expect(validerCheminInterne(trop)).toBeNull();
  });
});

describe("validerCheminInterne — contrat (fonction totale)", () => {
  it("ne jette JAMAIS et ne peut JAMAIS rendre un hôte", () => {
    const entrees: unknown[] = [
      "/",
      "//evil.example",
      "/\\evil.example",
      // Dot-segments : la classe d'entrée qui déclenche RÉELLEMENT l'invariant
      // `!startsWith("//")` (le trou de couverture d'origine — l'assertion existait
      // mais aucune entrée ne l'exerçait).
      "/..//evil.example",
      "/%2e%2e//evil.example",
      "/..///evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "%",
      "/%",
      "/%zz",
      "\\",
      "",
      "   ",
      null,
      undefined,
      42,
      Number.NaN,
      {},
      [],
    ];
    for (const e of entrees) {
      const res = validerCheminInterne(e);
      // Sortie = null, ou un chemin RELATIF : jamais d'origine, jamais protocol-relative.
      expect(res === null || res.startsWith("/")).toBe(true);
      expect(res?.startsWith("//") ?? false).toBe(false);
      expect(res?.includes("tygr.invalid") ?? false).toBe(false);
      expect(res?.includes("evil.example") ?? false).toBe(false);
    }
  });
});
