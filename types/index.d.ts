/** O que um plano informa: o estado e o nome de cada etapa e o percentual dito pelo Claude. */
export type Plan = {
  /** Estado de cada etapa do plano, na ordem ("pending", "in_progress", "completed"). */
  steps: string[]
  /** Nome de cada etapa, na mesma ordem de `steps` ("" quando o plano não deu nome). */
  names: string[]
  /** Etapas do plano concluídas e no total (0 quando não há plano), derivadas de `steps`. */
  done: number
  total: number
  /** Há uma etapa em andamento: conta como meia etapa feita. */
  hasActive: boolean
  /** Percentual informado pelo próprio Claude (0 a 100), se houver. */
  percent: number | null
}

/** A tarefa em andamento (ou a última concluída), como a faixa a desenha. */
export type Task = Plan & {
  /** Começo do pedido, cortado para caber na faixa. */
  title: string
  startedAt: number
  /** null enquanto roda. */
  finishedAt: number | null
  /** O turno acabou mas ainda há trabalho (etapas pendentes ou menos de 100%): em pausa desde. */
  pausedAt: number | null
  /** A pessoa interrompeu o turno: a faixa diz "Interrompida", não "Concluída". */
  stopped: boolean
  /** Tempo restante informado pelo Claude e quando ele informou. */
  etaMs: number | null
  etaAt: number
  /** O que está sendo feito agora, nas palavras do Claude. */
  label: string
  /** Chamadas de ferramenta da tarefa. */
  tools: number
}

/** Um trabalho em segundo plano da tarefa: um subagente ou um comando. */
export type Job = Plan & {
  /** O id do agente, ou o id da tarefa em segundo plano do comando. */
  id: string
  kind: 'agent' | 'command'
  /** A descrição curta do agente ou do comando. */
  title: string
  startedAt: number
  /** null enquanto roda. */
  endedAt: number | null
  status: 'running' | 'completed' | 'failed' | 'stopped'
  /** Chamadas de ferramenta do agente (sempre 0 num comando). */
  tools: number
}

/** Médias das tarefas anteriores, usadas antes de haver outro sinal. */
export type History = {
  tasks: number
  avgTaskMs: number
  steps: number
  avgStepMs: number
  /** Duração média dos subagentes e dos comandos em segundo plano concluídos. */
  agents: number
  avgAgentMs: number
  commands: number
  avgCommandMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': {
      task: Shaped<Task | null>
      jobs: Shaped<Job[]>
      tick: number
      history: Shaped<History>
    }
  }
}
