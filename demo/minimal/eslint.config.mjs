import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

// Flat config (ESLint 9 / Next 16): `next lint` is gone in Next 16, so `lint`
// runs eslint against next/core-web-vitals and next/typescript directly.
const config = [
  { ignores: ['.next/**', 'next-env.d.ts'] },
  ...coreWebVitals,
  ...typescript,
  {
    // page.tsx creates the Ably client and picks the channel name in effects,
    // which is what keeps the server render and the browser's first render
    // the same. Both effects synchronise React with something outside it (a
    // connection, the URL), which the rule cannot tell from a cascading
    // setState, so it is off for that file only.
    files: ['src/app/page.tsx'],
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
];

export default config;
