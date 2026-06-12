/**
 * Configuration Auth.js v5 (plan E6, décision #48) — stratégie JWT.
 *
 * Pourquoi JWT et pas sessions DB : l'adaptateur DB et le provider Credentials
 * ne sont pas supportés ensemble par Auth.js (E6). La fraîcheur est garantie
 * autrement : withWorkspace re-valide la MEMBERSHIP à chaque requête (E14) et
 * le bridge session re-valide users.is_active à chaque requête (E6) — un
 * compte désactivé ou retiré perd l'accès à la requête suivante, pas à
 * l'expiration du token.
 *
 * AUTH_SECRET : lu depuis l'environnement par Auth.js (jamais en dur — règle 8).
 */
import argon2 from "argon2";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { identite } from "@/server/db";
import { extraireIp } from "@/server/auth/rate-limit-ip";
import {
  extraireIdentifiants,
  verifierIdentifiants,
} from "@/server/auth/verifier-identifiants";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email" },
        motDePasse: { label: "Mot de passe", type: "password" },
      },
      async authorize(credentials, request) {
        // x-forwarded-for : fiable derrière un proxy de confiance uniquement
        // (Vercel/ALB) — limite documentée dans rate-limit-ip.ts.
        const ip = extraireIp(request.headers.get("x-forwarded-for"));
        const resultat = await verifierIdentifiants(
          {
            identite,
            verifierMotDePasse: (hash, motDePasse) =>
              argon2.verify(hash, motDePasse).catch(() => false),
            maintenant: () => new Date(),
          },
          extraireIdentifiants(credentials),
          ip,
        );

        if (!resultat.ok) {
          // Log structuré (règle 3) : code machine + IP, JAMAIS l'email ni le
          // mot de passe (logs sans PII, règle 8). L'UI reçoit null → message
          // générique unique, quel que soit le code (non-énumération E18).
          console.warn(
            JSON.stringify({
              evenement: "connexion_refusee",
              code: resultat.code,
              ip,
            }),
          );
          return null;
        }

        console.info(
          JSON.stringify({
            evenement: "connexion_reussie",
            userId: resultat.utilisateur.id,
          }),
        );
        return {
          id: resultat.utilisateur.id,
          email: resultat.utilisateur.email,
          name: resultat.utilisateur.fullName,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // `user` n'est défini qu'à la connexion : on fige userId et on résout le
      // workspace actif par défaut = premier membership (tri déterministe par
      // workspace_id, lu sous RLS via own_memberships_select). Le sélecteur de
      // workspace (PR 2) mettra à jour activeWorkspaceId via session update.
      if (user?.id) {
        token.userId = user.id;
        const memberships = await identite.membershipsDe(user.id);
        token.activeWorkspaceId = memberships[0]?.workspaceId ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.userId === "string") {
        session.userId = token.userId;
      }
      session.activeWorkspaceId = token.activeWorkspaceId ?? null;
      return session;
    },
  },
});
