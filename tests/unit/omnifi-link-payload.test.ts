/**
 * Normalisation du payload `onSuccess` du widget natif Omni-FI
 * (`connexionsDepuisPayload`, `omnifi-link-launcher.tsx`).
 *
 * Régression réelle (runtime 2026-06-19) : le CDN déployé
 * (`omni-fi-connect.js`, `e.onSuccess(n.connections)`) passe le TABLEAU NU à
 * `onSuccess`, alors que les TYPES + README vendorés promettent un OBJET
 * `{ connections: [...] }`. Notre code suivait les types → `payload.connections`
 * était `undefined` → `TypeError ...reading 'map'` → widget bloqué sur
 * « Finishing… » (cf. OMNIFI_API_FEEDBACK.md). On doit donc accepter LES DEUX
 * formes. Ce test verrouille ce contrat défensif.
 */
import { describe, expect, it } from "vitest";

import { connexionsDepuisPayload } from "@/components/widget/omnifi-link-launcher";

const c1 = { publicToken: "pt_1", connectionId: "c1", institutionId: "inst_absa" };
const c2 = { publicToken: "pt_2", connectionId: "c2", institutionId: "inst_one" };

describe("connexionsDepuisPayload", () => {
  it("forme RUNTIME du CDN : tableau nu → renvoie le tableau tel quel", () => {
    // C'est la forme réellement émise par omni-fi-connect.js (e.onSuccess(n.connections)).
    expect(connexionsDepuisPayload([c1, c2])).toEqual([c1, c2]);
  });

  it("forme DOCUMENTÉE (types/README) : { connections } → renvoie le tableau interne", () => {
    expect(connexionsDepuisPayload({ connections: [c1, c2] })).toEqual([c1, c2]);
  });

  it("tableau vide → tableau vide (aucun token à finaliser)", () => {
    expect(connexionsDepuisPayload([])).toEqual([]);
  });

  it("{ connections: [] } → tableau vide", () => {
    expect(connexionsDepuisPayload({ connections: [] })).toEqual([]);
  });

  it("payload dégénéré (connections absent/non-tableau) → [] sans throw", () => {
    // Garde-fou : un payload inattendu ne doit JAMAIS jeter (sinon « Finishing… »
    // bloqué). On retombe sur [] → le launcher n'appelle simplement pas onConnexions.
    expect(connexionsDepuisPayload({} as never)).toEqual([]);
    expect(connexionsDepuisPayload({ connections: null } as never)).toEqual([]);
    expect(connexionsDepuisPayload(null as never)).toEqual([]);
    expect(connexionsDepuisPayload(undefined as never)).toEqual([]);
  });
});
