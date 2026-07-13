/**
 * Règle UNIQUE de « compte non assigné » — L1 de `PLAN-refonte-entites.md` (constat C1).
 *
 * Ce qu'on verrouille ici n'est pas une fonction de trois lignes : c'est l'INVARIANT
 * qu'elle protège. Le bandeau récap annonce « K comptes non assignés » (le reste-à-faire
 * de l'écran) et, juste dessous, le tableau groupe ces mêmes comptes sous
 * « — Unassigned — ». Si les deux surfaces dérivaient la notion chacune de leur côté,
 * elles divergeraient sur le cas de l'ENTITÉ ARCHIVÉE — et l'écran afficherait
 * « 0 compte non assigné » au-dessus d'un groupe qui en contient douze.
 *
 * Le cas limite est le cœur du sujet : `archiverEntite` ne fait qu'un `is_active = false`.
 * Il ne touche PAS `bank_accounts.entity_id`. Un compte garde donc son `entity_id` en base
 * alors que son entité a disparu des sélecteurs : il est orphelin à l'écran.
 */
import { describe, expect, it } from "vitest";

import {
  compterNonAssignes,
  estNonAssigne,
} from "@/app/(workspace)/admin/entites/regles-comptes";

const ENT_ACTIVE = "11111111-1111-4111-8111-111111111111";
const ENT_ARCHIVEE = "22222222-2222-4222-8222-222222222222";

/** Ce que la page passe : les ids des entités ACTIVES (celles rendues dans les pickers). */
const ACTIVES: ReadonlySet<string> = new Set([ENT_ACTIVE]);

describe("estNonAssigne — chemin heureux", () => {
  it("un compte rattaché à une entité ACTIVE est assigné", () => {
    expect(estNonAssigne({ entityId: ENT_ACTIVE }, ACTIVES)).toBe(false);
  });

  it("un compte sans entité (entity_id NULL) est non assigné", () => {
    expect(estNonAssigne({ entityId: null }, ACTIVES)).toBe(true);
  });
});

describe("estNonAssigne — LE cas limite : l'entité archivée (constat C1)", () => {
  it("un compte rattaché à une entité ARCHIVÉE est « non assigné » — il garde pourtant son entity_id en base", () => {
    // C'est tout l'enjeu : un test naïf `entityId === null` répondrait `false` ici, et le
    // bandeau annoncerait « 0 non assigné » pendant que le tableau range ce compte sous
    // « — Unassigned — ». Les deux surfaces se contrediraient sur le même écran.
    expect(estNonAssigne({ entityId: ENT_ARCHIVEE }, ACTIVES)).toBe(true);
  });

  it("aucune entité active (toutes archivées) ⇒ TOUS les comptes sont non assignés", () => {
    const aucune: ReadonlySet<string> = new Set();
    expect(estNonAssigne({ entityId: ENT_ACTIVE }, aucune)).toBe(true);
    expect(estNonAssigne({ entityId: null }, aucune)).toBe(true);
  });
});

describe("compterNonAssignes — le chiffre mis en avant par le bandeau", () => {
  it("compte les NULL et les entités archivées, jamais les entités actives", () => {
    const comptes = [
      { entityId: ENT_ACTIVE }, // assigné
      { entityId: null }, // non assigné (jamais rangé)
      { entityId: ENT_ARCHIVEE }, // non assigné (entité archivée) ← le piège
      { entityId: ENT_ACTIVE }, // assigné
      { entityId: null }, // non assigné
    ];
    expect(compterNonAssignes(comptes, ACTIVES)).toBe(3);
  });

  it("liste vide ⇒ 0 (aucune banque connectée : l'écran affiche son état vide)", () => {
    expect(compterNonAssignes([], ACTIVES)).toBe(0);
  });

  it("tout est rangé ⇒ 0 (le bandeau passe en « tout est rangé »)", () => {
    expect(
      compterNonAssignes([{ entityId: ENT_ACTIVE }, { entityId: ENT_ACTIVE }], ACTIVES),
    ).toBe(0);
  });
});
