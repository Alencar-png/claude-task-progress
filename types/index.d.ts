/** A tarefa em andamento (ou a última concluída), como a faixa a desenha. */
export type Task = {
  /** Começo do pedido, cortado para caber na faixa. */
  title: string
  startedAt: number
  /** null enquanto roda. */
  finishedAt: number | null
  /** Etapas do plano concluídas e no total (0 quando não há plano). */
  done: number
  total: number
  /** Há uma etapa em andamento: conta como meia etapa feita. */
  hasActive: boolean
  /** Percentual informado pelo próprio Claude (0 a 100), se houver. */
  percent: number | null
  /** Tempo restante informado pelo Claude e quando ele informou. */
  etaMs: number | null
  etaAt: number
  /** O que está sendo feito agora, nas palavras do Claude. */
  label: string
  /** Chamadas de ferramenta da tarefa. */
  tools: number
}

/** Médias das tarefas anteriores, usadas antes de haver outro sinal. */
export type History = {
  tasks: number
  avgTaskMs: number
  steps: number
  avgStepMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': {
      task: Shaped<Task | null>
      tick: number
      history: Shaped<History>
    }
  }
}
