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

## Steps and background work

When the task has a plan or something runs in the background, the band shows a **Ver etapas**
button (hotkey `e` while the band has the focus). It opens a pane with:

- each step of the plan, marked done (`✓`), in progress (`›`) or pending (`·`);
- each subagent and each background command, with its own progress bar and time estimate.

A job's bar follows its own plan or `report_progress` calls when it has them; otherwise it is the
time elapsed over the average of earlier jobs of the same kind, held at 95% until the job ends.
While background work is still running at the end of a turn, the band shows `Em pausa` instead of
100%.

```
Agente: Revisar o código                 ██████████░░░░░░  62%
1min 40s decorridos · faltam ~1 min · 2/4 etapas · 18 ferramentas
Comando: Testes da Godot                 ████████████████  100%
concluído em 3min 05s
```

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
`média das tarefas`. A message sent in the middle of the work, or a background task's notice, does
not restart the count. Subagents get their own bars in the steps pane instead of moving the main
one.

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

### Etapas e segundo plano

Quando a tarefa tem um plano ou algo roda em segundo plano, a faixa mostra o botão **Ver etapas**
(atalho `e` com a faixa em foco). Ele abre um painel com cada etapa do plano e, para cada subagente
e cada comando em segundo plano, uma barra de progresso própria com a estimativa de tempo.

### De onde vem a estimativa

1. **Estimativa do Claude.** O plugin registra a ferramenta `report_progress`; o Claude a chama no
   começo da tarefa e a cada marco, com o percentual feito e os minutos que faltam.
2. **Ritmo atual.** Etapas concluídas da lista de tarefas contra o tempo decorrido.
3. **Histórico.** Média por etapa e por tarefa das tarefas anteriores, guardada entre sessões.

A estimativa do Claude custa uma chamada curta de ferramenta no início e a cada marco. Nenhum dado
sai da máquina.

## License

[MIT](LICENSE)
