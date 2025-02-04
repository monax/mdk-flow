export function lazyloadObject<T extends object>(init: () => T): T {
  let obj: T | null = null;
  return new Proxy(
    {},
    {
      get(_target, prop, _receiver) {
        if (obj === null) {
          obj = init();
        }
        return obj[prop as keyof T];
      },
    },
  ) as T;
}
