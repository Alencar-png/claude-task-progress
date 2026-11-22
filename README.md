# task-progress

A Claude Code plugin that shows a live progress bar and a time estimate for every task you give
Claude.

*Plugin para o Claude Code que mostra uma barra de progresso e uma estimativa de tempo, em tempo
real, para cada tarefa passada ao Claude. [Leia em português](#português).*

```
Refatorando os testes · 45% · 3/7 etapas   ████████░░░░░░░░░░
4min 12s decorridos · faltam ~6 min (ritmo atual)
```

A band appears above the prompt for each request and updates every second. When the task ends it
shows `Concluída em …` for 45 seconds.

> The band's text is in Portuguese (`decorridos`, `faltam`, `etapas`). The label of the task
> follows the language you write in.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install task-progress --marketplace Alencar-png/claude-task-progress
```

Answer `y` to add the marketplace, then pick a scope (the user scope loads it in every session).

From a shell:

```bash
claude plugin install task-progress --marketplace Alencar-png/claude-task-progress
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then
**Plugins**, **Add marketplace** with `Alencar-png/claude-task-progress`, then **Add plugin**.

## Where the estimate comes from

The plugin uses the best signal available, in this order:

1. **Claude's own estimate.** The plugin registers a `report_progress` tool. Claude calls it at
   the start of a task and at each milestone, with the percent done and the minutes left.
2. **Current pace.** Completed steps of the task list (the desktop app's or the terminal's)
   against the time elapsed.
3. **History.** The average time per step and per task of your earlier tasks, kept between
   sessions.

The line says which one is in use: `estimativa do Claude`, `ritmo atual`, `média por etapa` or
`média das tarefas`. A message sent in the middle of the work does not restart the count, and
subagents do not count: only the main turn.

## Cost and privacy

Claude's estimate costs one short tool call at the start of a task and at each milestone. Nothing
leaves your machine: the history lives in the plugin's local store.

## Development

```bash
claude plugin validate .   # manifest, hooks and types
claude plugin test .       # the tests in hooks/progress.test.ts
claude --plugin-dir .      # run it from this folder, with hot reload
```

The hooks module is `hooks/register.tsx`; the state it keeps is declared in `types/index.d.ts`.

## Português

A cada pedido, uma faixa aparece acima da caixa de mensagem com uma barra de progresso e uma linha
como `4min 12s decorridos · faltam ~6 min (ritmo atual)`, atualizada a cada segundo. Ao terminar,
mostra `Concluída em …` por 45 segundos.

### Instalação

No prompt de uma sessão do Claude Code no terminal:

```
/plugin install task-progress --marketplace Alencar-png/claude-task-progress
```

Responda `y` para adicionar o marketplace e escolha o escopo (o de usuário carrega o plugin em
todas as sessões). No app desktop: **+** ao lado da caixa de mensagem, **Plugins**, **Add
marketplace** com `Alencar-png/claude-task-progress` e depois **Add plugin**.

### De onde vem a estimativa

1. **Estimativa do Claude.** O plugin registra a ferramenta `report_progress`; o Claude a chama no
   começo da tarefa e a cada marco, com o percentual feito e os minutos que faltam.
2. **Ritmo atual.** Etapas concluídas da lista de tarefas contra o tempo decorrido.
3. **Histórico.** Média por etapa e por tarefa das tarefas anteriores, guardada entre sessões.

A estimativa do Claude custa uma chamada curta de ferramenta no início e a cada marco. Nenhum dado
sai da máquina.

## License

[MIT](LICENSE)
