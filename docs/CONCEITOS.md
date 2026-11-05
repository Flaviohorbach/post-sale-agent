# Conceitos do módulo 8, explicados pelo projeto

Guia de estudo em português: o que é um agente, quando usar vários e como deixá-los decidir sem entregar a chave do cofre.

## 1. Agente, loop e ferramenta

Um **agente** é um modelo em loop: ele decide o próximo passo, chama uma ferramenta, lê o resultado e repete até terminar. O padrão clássico se chama **ReAct** (*reason + act*).

Veja `resolve` em `src/agent/agents.ts`. Para reenviar um pedido, o agente precisa descobrir sozinho que tem de chamar `search_products` para achar o SKU e depois `check_inventory`. Nada no código diz essa sequência. Um trecho de código com passos fixos seria um **workflow**, não um agente.

**Sempre com limite.** `stepCountIs(6)` impede que um agente perdido gaste toda a cota. Agente sem limite é um `while(true)` que cobra por volta.

**A ferramenta que termina o loop.** `submit_decision` não tem `execute`: quando o modelo a chama, o loop para. É um jeito limpo de obter uma resposta estruturada no fim de um agente.

## 2. Quando usar um agente, e quando não usar

Boa parte do fluxo aqui **não é agente**, de propósito: consultar o pedido, calcular o atraso, decidir o que é permitido, executar. O artigo *Building effective agents*, da Anthropic, recomenda a solução mais simples que funcione.

Na tela, cada passo mostra quantas chamadas de modelo gastou, e vários gastam zero. Essa é uma resposta boa para entrevista: "uso modelo onde há linguagem ou julgamento; o resto é código, porque é mais barato, mais rápido e testável".

## 3. O grafo: por que LangGraph

O caso é um grafo em `src/agent/graph.ts`: pedido, triagem, política, resolução, revisão, aprovação e execução. Um `if` aninhado faria o mesmo até surgirem as necessidades abaixo, e são elas que justificam a biblioteca:

- **Checkpoint:** o estado é salvo depois de cada nó.
- **Pausa e retomada:** `interrupt()` para o grafo e devolve o controle.
- **Retomada depois de falha:** o `retry` continua do último passo salvo.

**Divisão de tarefas:** o LangGraph orquestra, e o AI SDK fala com os modelos. Isso mantém a cadeia de fallback dos módulos anteriores.

## 4. Multiagente: três papéis

| Agente | Trabalho | Ferramentas |
| --- | --- | --- |
| **Triagem** | Classificar a mensagem | nenhuma |
| **Resolução** | Propor uma ação e escrever a resposta | só leitura, e só quando precisa |
| **Revisor** | Julgar a proposta | nenhuma |

**Reflection** é o nome do padrão em que um agente critica o trabalho de outro. O revisor devolve a correção, e a resolução tenta de novo, no máximo duas vezes. Depois disso, o caso vai para uma pessoa.

**Quando vale a pena?** Separar papéis dá prompts menores e menos ferramentas por agente. O custo é claro: cada papel é mais uma chamada. Se o revisor quase nunca reprovar, ele é só gasto. O campo `attempts` em `eval/results.json` mede isso.

**O que os números disseram aqui:** média de 3,7 chamadas por caso. O revisor devolveu 1 proposta em 12, e essa devolução foi discutível. Ele também aprovou uma invenção (a frigideira "não tem outras cores"), que só apareceu quando li as respostas. Uma rodada é pouca evidência, mas mostra por que "mais agentes" não é sinônimo de "mais qualidade". Numa entrevista, isso vale mais do que dizer que usou multiagente.

## 5. O modelo propõe, o código decide

Esta é a ideia central do projeto. **Regra de negócio não fica em prompt**, porque texto pode convencer um modelo de qualquer coisa.

Veja `src/agent/policy.ts`:

- **O que é permitido** vem de `computeFacts`, em código. O esquema de `submit_decision` só aceita as ações permitidas: uma ação proibida nem pode ser escrita.
- **O valor do reembolso** vem do pedido. O modelo não tem campo para informar valor.
- **Evidência:** reenviar exige ter consultado o estoque de verdade. `checkProposal` confere o que as ferramentas retornaram, não o que o modelo diz.
- **Números na mensagem:** todo valor em reais precisa existir no pedido. É a lição do módulo 2 sobre invenções.

## 6. Human-in-the-loop

Veja `humanGate` em `graph.ts`. Reembolso acima de R$ 300 chama `interrupt()`, e o processo pode até acabar: o estado fica no Postgres, e a aprovação pode chegar dias depois, em outra instância. `tests/persistence.test.ts` prova isso com duas instâncias que só compartilham o banco.

**A armadilha do `interrupt`:** ao retomar, o nó roda **de novo desde o início**. Por isso, nada antes do `interrupt` pode ter efeito colateral. Se o reembolso ficasse antes dele, seria pago duas vezes.

## 7. Idempotência: fazer uma vez só

Redes falham e pessoas clicam duas vezes. Há duas proteções:

- **`claim`** troca o status de forma atômica (`UPDATE ... WHERE status = 'waiting'`). De dois cliques, só um vence.
- **`executed_actions`** tem chave primária `(case_id, action)`. Mesmo que algo escape, o banco recusa o segundo registro.

## 8. Limites deste projeto, para dizer em entrevista

- **Nenhuma ação é real:** elas só são registradas. Pagamento de verdade exigiria chave de idempotência também no provedor.
- **Quem tem o link aprova.** Em produção, precisaria de login e de um papel de aprovador.
- **Sem histórico da conversa:** cada caso é uma mensagem.
- **Data fixa:** a loja simulada é um retrato, então o "hoje" também é fixo.
- **Política simplificada:** reembolso só integral, por exemplo.

## Exercícios

1. **Quebre o `interrupt`.** Mova `ledger.record` para antes do `interrupt` em `humanGate` e rode os testes. Por que o resultado mudou?
2. **Tire o revisor.** Ligue `resolve` direto em `human_gate`. Quantas chamadas você economiza? Que casos da avaliação pioram? O revisor se paga?
3. **Supervisor.** Hoje a ordem é fixa. Como seria um agente supervisor escolhendo o próximo? O que você ganha e o que perde em previsibilidade?
4. **Reembolso parcial.** Onde entra o valor? Como impedir que o modelo ofereça mais do que o pedido custou?
