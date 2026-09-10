export function pLimit(concurrency: number) {
  type Task = () => Promise<unknown>;
  type Resolver = (value: unknown) => void;
  type Rejector = (reason?: unknown) => void;

  const q: [Task, Resolver, Rejector][] = [];
  let active = 0;

  const run = async (fn: Task, resolve: Resolver, reject: Rejector) => {
    active++;
    try {
      resolve(await fn());
    } catch (error) {
      reject(error);
    } finally {
      active--;
      if (q.length) {
        const next = q.shift();
        if (next) {
          const [nextFn, nextResolve, nextReject] = next;
          run(nextFn, nextResolve, nextReject);
        }
      }
    }
  };

  return <T>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    const wrappedResolve = resolve as Resolver;
    const wrappedReject = reject as Rejector;
    if (active < concurrency) run(fn, wrappedResolve, wrappedReject);
    else q.push([fn, wrappedResolve, wrappedReject]);
  });
}
