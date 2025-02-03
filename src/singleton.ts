const singletonInstances = new Map<string, unknown>();

export const singletonSync = <T>(serviceName: string, getService: () => T): T => {
  if (!singletonInstances.has(serviceName)) {
    singletonInstances.set(serviceName, getService());
  }

  return singletonInstances.get(serviceName) as T;
};

export const singletonAsync = async <T>(serviceName: string, getService: () => Promise<T>): Promise<T> => {
  if (!singletonInstances.has(serviceName)) {
    singletonInstances.set(serviceName, await getService());
  }

  return singletonInstances.get(serviceName) as T;
};
