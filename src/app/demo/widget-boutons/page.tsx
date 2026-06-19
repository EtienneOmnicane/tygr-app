/**
 * Démo / Visual QA (Gate 4) des boutons du widget de connexion bancaire
 * (`BankConnectWidget`) — vérifie le renommage #1 « Synchroniser mes comptes »
 * (+ icône ↻) à côté de l'action principale « Connecter une banque ».
 *
 * NON destinée à la production. Le widget consomme des Server Actions (échange
 * LinkToken) : ici on ne les déclenche pas, on capture seulement l'état au repos
 * (les deux boutons rendus). `peutConnecter` à true pour montrer la barre d'actions.
 */
import { BankConnectWidget } from "@/components/widget/bank-connect-widget";

export const metadata = { title: "Démo — Boutons widget banque" };

export default function DemoWidgetBoutons() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <p className="mb-6 text-sm text-text-muted">
        Démo · Visual QA — barre d’actions du widget de connexion (données fictives).
      </p>
      <div className="rounded-card bg-surface-card p-6 shadow-card">
        <BankConnectWidget peutConnecter={true} />
      </div>
    </main>
  );
}
