type DiagnosticEvent = {
  type: string;
  payload?: unknown;
  timestamp: number;
};

type Handler = (event: DiagnosticEvent) => void;
type Unsubscribe = () => void;

interface Diagnostics {
  log(type: string, payload?: unknown): void;
  onEvent(handler: Handler): Unsubscribe;
}

const HISTORY_LIMIT = 50;

/**
 * Subscribers attach after async work (e.g. awaiting bootWC()), by which point
 * boot-time events like the initial PING/PONG have already fired - onEvent()
 * replays recent history so a late subscriber still sees what already happened.
 */
const createDiagnostics = (): Diagnostics => {
  const handlers = new Set<Handler>();
  const history: DiagnosticEvent[] = [];

  return {
    log(type, payload) {
      const event: DiagnosticEvent = { type, payload, timestamp: Date.now() };
      history.push(event);
      if (history.length > HISTORY_LIMIT) history.shift();
      handlers.forEach((handler) => handler(event));
    },
    onEvent(handler) {
      history.forEach((event) => handler(event));
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
};

export { createDiagnostics };
export type { DiagnosticEvent, Diagnostics };
