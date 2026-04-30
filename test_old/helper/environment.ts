export const isNonSandboxEnvironment = (): boolean =>
  process.env.VITE_ABLY_ENV !== undefined && process.env.VITE_ABLY_ENV !== 'sandbox';

export const testEndpoint = (): string | undefined => {
  switch (process.env.VITE_ABLY_ENV) {
    case 'local': {
      return 'local-rest.ably.io';
    }
    case 'production': {
      return;
    }
    default: {
      return 'nonprod:sandbox';
    }
  }
};

export const isLocalEnvironment = (): boolean => process.env.VITE_ABLY_ENV === 'local';

export const ablyApiKey = (): string | undefined =>
  isNonSandboxEnvironment() ? process.env.VITE_ABLY_API_KEY : process.env.sandboxApiKey;
