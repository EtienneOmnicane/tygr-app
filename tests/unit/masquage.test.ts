/**
 * `masquerCompte` — fonction pure, source unique du masquage PII (règle 8).
 *
 * L'invariant testé n'est pas « le format est joli » mais « aucune entrée, quelle
 * qu'elle soit, ne ressort en clair ». D'où les bornes : null, vide, plus court
 * que la fenêtre visible.
 */
import { describe, expect, it } from "vitest";

import { masquerCompte } from "@/lib/masquage";

const PREFIXE = "••••";

describe("masquerCompte — chemin heureux", () => {
  it("ne rend que les 4 derniers caractères, préfixés", () => {
    expect(masquerCompte("MU17BOMM0101234567890123456789")).toBe("••••6789");
  });

  it("masque un identifiant Omni-FI (UUID) sans en révéler la structure", () => {
    expect(masquerCompte("f1111111-1111-4111-8111-111111111abc")).toBe("••••1abc");
  });

  it("rend exactement 4 caractères visibles quand l'entrée en fait 4", () => {
    expect(masquerCompte("4321")).toBe("••••4321");
  });
});

describe("masquerCompte — bornes (aucune fuite)", () => {
  it("null → préfixe seul", () => {
    expect(masquerCompte(null)).toBe(PREFIXE);
  });

  it("undefined → préfixe seul", () => {
    expect(masquerCompte(undefined)).toBe(PREFIXE);
  });

  it("chaîne vide → préfixe seul", () => {
    expect(masquerCompte("")).toBe(PREFIXE);
  });

  it("chaîne d'espaces → préfixe seul (après trim)", () => {
    expect(masquerCompte("   ")).toBe(PREFIXE);
  });

  it("chaîne trop courte → préfixe seul, JAMAIS l'entrée en clair", () => {
    // Le piège : un repli « trop court, on renvoie tel quel » laisserait passer
    // un numéro de compte de 3 chiffres. On masque totalement.
    expect(masquerCompte("123")).toBe(PREFIXE);
    expect(masquerCompte("1")).toBe(PREFIXE);
  });

  it("la longueur de l'entrée n'est pas observable dans la sortie", () => {
    const court = masquerCompte("9876");
    const long = masquerCompte("00000000000000000000009876");
    expect(court).toBe(long);
  });
});

describe("masquerCompte — robustesse à la frontière JS (entrée non typée)", () => {
  it("une valeur non-chaîne (JS non typé) → préfixe seul, pas d'exception", () => {
    const nonTypee = masquerCompte as unknown as (v: unknown) => string;
    expect(nonTypee(42)).toBe(PREFIXE);
    expect(nonTypee({})).toBe(PREFIXE);
    expect(nonTypee([])).toBe(PREFIXE);
  });
});
