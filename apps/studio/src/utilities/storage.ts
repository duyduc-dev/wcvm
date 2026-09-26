export function getLocalStorage<T>(key: string): T | null;
export function getLocalStorage<T>(key: string, defaultValue: T): T;
export function getLocalStorage<T>(
  key: string,
  defaultValue: T | null = null,
): T | null {
  try {
    const data = localStorage.getItem(key);
    if (data === null) return defaultValue;
    return (JSON.parse(data) as T) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

export const getLocalStorageString = (
  key: string,
  defaultValue: string | null = null,
): string | null => {
  return localStorage.getItem(key) || defaultValue;
};

export const setLocalStorage = <T = unknown>(key: string, payload: T) => {
  localStorage.setItem(
    key,
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );
};
