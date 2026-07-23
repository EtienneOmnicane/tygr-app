/**
 * Décision de résolution tenant (§10.1 cas 4). Fonction PURE : 0 → CONNEXION_INCONNUE,
 * 1 → RESOLUE, ≥2 → AMBIGUE (SANS JAMAIS choisir). Couvre la garde de multiplicité que
 * le SQL `LIMIT 2` alimente (le SQL lui-même n'est exerçable qu'au CONTRACT — §5.4).
 */
import { describe, expect, it } from "vitest";

import type { LigneConnexionResolue } from "@/server/db/service";
import { deciderResolution } from "@/server/webhooks/omnifi/resolution";

const ligne = (workspaceId: string): LigneConnexionResolue => ({
  id: `id-${workspaceId}`,
  omnifiConnectionId: "omni-conn-1",
  workspaceId,
});

describe("deciderResolution", () => {
  it("0 ligne → quarantaine CONNEXION_INCONNUE (webhook avant link-exchange, nominal)", () => {
    expect(deciderResolution([])).toEqual({
      type: "QUARANTAINE",
      motif: "CONNEXION_INCONNUE",
    });
  });

  it("1 ligne → RESOLUE avec la connexion candidate", () => {
    const l = ligne("ws-A");
    expect(deciderResolution([l])).toEqual({ type: "RESOLUE", connexion: l });
  });

  it("2 lignes (2 tenants) → quarantaine AMBIGUE, JAMAIS un choix arbitraire", () => {
    const d = deciderResolution([ligne("ws-A"), ligne("ws-B")]);
    expect(d).toEqual({ type: "QUARANTAINE", motif: "AMBIGUE" });
    // On s'assure qu'aucune connexion n'est renvoyée (pas de routage au hasard).
    expect("connexion" in d).toBe(false);
  });
});
