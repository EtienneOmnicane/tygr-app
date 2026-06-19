/**
 * Extraction des PublicTokens du payload `onSuccess` du widget natif Omni-FI
 * (`publicTokensDepuisPayload`, `omnifi-link-launcher.tsx`).
 *
 * Régression réelle (runtime 2026-06-19) : le CDN déployé
 * (`omni-fi-connect.js`, `e.onSuccess(n.connections)`) passe le TABLEAU NU à
 * `onSuccess`, alors que les TYPES + README vendorés promettent un OBJET
 * `{ connections: [...] }`. Notre code suivait les types → `payload.connections`
 * était `undefined` → `TypeError ...reading 'map'` → widget bloqué sur
 * « Finishing… » (cf. OMNIFI_API_FEEDBACK.md). Le contrat amont étant instable,
 * la fonction tolère TROIS niveaux de dégénérescence (conteneur / élément / token)
 * sans jamais jeter. Ce test verrouille ce contrat défensif.
 */
import { describe, expect, it } from "vitest";

import { publicTokensDepuisPayload } from "@/components/widget/omnifi-link-launcher";

const c1 = { publicToken: "pt_1", connectionId: "c1", institutionId: "inst_absa" };
const c2 = { publicToken: "pt_2", connectionId: "c2", institutionId: "inst_one" };

describe("publicTokensDepuisPayload", () => {
  it("forme RUNTIME du CDN : tableau nu → extrait les publicToken", () => {
    // C'est la forme réellement émise par omni-fi-connect.js (e.onSuccess(n.connections)).
    expect(publicTokensDepuisPayload([c1, c2])).toEqual(["pt_1", "pt_2"]);
  });

  it("forme DOCUMENTÉE (types/README) : { connections } → extrait les publicToken", () => {
    expect(publicTokensDepuisPayload({ connections: [c1, c2] })).toEqual(["pt_1", "pt_2"]);
  });

  it("tableau vide → [] (aucun token à finaliser)", () => {
    expect(publicTokensDepuisPayload([])).toEqual([]);
  });

  it("{ connections: [] } → []", () => {
    expect(publicTokensDepuisPayload({ connections: [] })).toEqual([]);
  });

  it("élément null/undefined dans le tableau → ignoré, pas de throw (finding revue)", () => {
    // Le CDN peut, en théorie, glisser un élément dégénéré ; `c?.publicToken` doit
    // l'écarter au lieu de crasher (sinon retour du blocage « Finishing… »).
    expect(publicTokensDepuisPayload([c1, null as never, c2])).toEqual(["pt_1", "pt_2"]);
    expect(publicTokensDepuisPayload([null as never, undefined as never])).toEqual([]);
  });

  it("publicToken absent / null / vide → filtré (on ne finalise que des tokens valides)", () => {
    const sansToken = { connectionId: "c3", institutionId: "inst_x" };
    const tokenNull = { publicToken: null, connectionId: "c4" };
    const tokenVide = { publicToken: "", connectionId: "c5" };
    expect(
      publicTokensDepuisPayload([c1, sansToken as never, tokenNull as never, tokenVide as never]),
    ).toEqual(["pt_1"]);
  });

  it("payload dégénéré (connections absent/non-tableau) → [] sans throw", () => {
    expect(publicTokensDepuisPayload({} as never)).toEqual([]);
    expect(publicTokensDepuisPayload({ connections: null } as never)).toEqual([]);
    expect(publicTokensDepuisPayload(null as never)).toEqual([]);
    expect(publicTokensDepuisPayload(undefined as never)).toEqual([]);
  });
});
