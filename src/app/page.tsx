import { Suspense } from "react";
import { CaseDesk } from "@/components/case-desk";

export default function Home() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header>
        <p className="font-display text-sm font-semibold tracking-wide text-accent">Agente de pós-venda</p>
        <h1 className="mt-1 font-display text-3xl font-semibold sm:text-4xl">“Meu pedido atrasou”: três agentes e uma pessoa resolvem</h1>
        <p className="mt-2 max-w-3xl text-muted">
          Um agente classifica, outro propõe e um terceiro revisa. As regras ficam em código, e reembolsos acima de R$ 300 esperam a sua aprovação. Veja cada decisão, com quem decidiu e por quê.
        </p>
      </header>

      <Suspense>
        <CaseDesk />
      </Suspense>

      <footer className="mt-12 border-t border-line pt-4 text-xs text-muted">
        Projeto de portfólio. Pedidos e pessoas são fictícios, consultados pelo <a className="underline" href="https://mcp-ecommerce-server.vercel.app">servidor MCP do projeto anterior</a>. Nenhuma ação é real. Casos são apagados em 7 dias: não escreva dados pessoais.
      </footer>
    </main>
  );
}
