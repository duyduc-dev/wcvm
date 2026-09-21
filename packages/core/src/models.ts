export interface ISpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface IState {
  processId: number;
}

export interface IProcessExit {
  errorCode: number;
  errorMessage?: string;
}

export interface IProcess {
  processId: number;
  exit: Promise<IProcessExit>;
}
