import { type ComponentType, lazy } from "react";

export type Preloadable<P extends object> = ComponentType<P> & { preload(): Promise<void> };

/**
 * React.lazy suspends on first render even when the chunk is already in memory, and React then
 * throttles revealing the content (~300ms). Once `preload()` has resolved, this renders the loaded
 * component directly, so prefetched UI opens instantly.
 */
export function preloadable<P extends object>(
  load: () => Promise<ComponentType<P>>,
): Preloadable<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const fetch = () => {
    pending ??= load().then((component) => {
      loaded = component;
      return component;
    });
    return pending;
  };
  const Lazy = lazy(() => fetch().then((component) => ({ default: component })));
  function Preloaded(props: P) {
    const Component = loaded ?? Lazy;
    return <Component {...props} />;
  }
  Preloaded.preload = () => fetch().then(() => undefined);
  return Preloaded;
}
