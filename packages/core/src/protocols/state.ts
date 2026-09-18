import { Diagnostics } from "./diagnostics";

export interface IStateManager<T extends object> {
  getState: () => T;
  setState: (newState: Partial<T> | ((prevState: T) => Partial<T>)) => void;
}

const createState = <T extends object>(
  initial: T,
  diagnostics: Diagnostics,
) => {
  let state: T = { ...initial };

  const getState = (): Readonly<T> => ({ ...state });

  const setState = (
    newState: Partial<T> | ((prevState: T) => Partial<T>),
  ): void => {
    diagnostics.log("state:update", {
      prevState: { ...state },
      newState:
        typeof newState === "function" ? newState(state) : { ...newState },
    });
    state = {
      ...state,
      ...(typeof newState === "function" ? newState(state) : newState),
    };
  };

  return { getState, setState };
};

export { createState };
