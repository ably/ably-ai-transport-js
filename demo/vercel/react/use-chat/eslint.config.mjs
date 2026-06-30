import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

// Flat config (ESLint 9 / Next 16). `next lint` was removed in Next 16, so the
// `lint` script now runs eslint directly against this config, which composes
// next/core-web-vitals and next/typescript (the rules the old .eslintrc used).
const config = [
  { ignores: ['.next/**', 'next-env.d.ts'] },
  ...coreWebVitals,
  ...typescript,
  {
    // These two files run effects that synchronise React with an external
    // system — exactly what effects are for: providers.tsx creates the
    // browser-only Ably client (and tears it down on cleanup) and chat.tsx
    // appends a transition entry whenever useChat's status changes. The
    // React-Compiler rule react-hooks/set-state-in-effect can't tell these
    // apart from accidental cascading setState, and a lazy useState initialiser
    // can't run the client teardown. Scope the rule off to just these files
    // rather than suppress inline.
    files: ['src/app/providers.tsx', 'src/app/chat.tsx'],
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
];

export default config;
