import { useCallback, useState } from 'react';
import { api, type Provider } from '../api';

/** Providers list (for the 🔌 panel + composer model select + project dialog). */
export function useProviders() {
  const [providers, setProviders] = useState<Provider[]>([]);

  const refreshProviders = useCallback(async () => {
    setProviders(await api.listProviders());
  }, []);

  /** Provider that fills the composer's model select for the given project. */
  const composerProvider = useCallback(
    (projectId?: string) =>
      providers.find((p) => p.id === (projectId ?? '')) ?? providers.find((p) => p.is_default),
    [providers]
  );

  const hasDetectionFailure = providers.some((p) => p.models_error);

  return { providers, refreshProviders, composerProvider, hasDetectionFailure };
}
