export interface ISpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface IState {
  processId: number;
}
