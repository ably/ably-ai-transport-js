import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

// Flat config (ESLint 9 / Next 16). `next lint` was removed in Next 16, so the
// `lint` script now runs eslint directly against this config, which composes
// next/core-web-vitals and next/typescript (the rules the old .eslintrc used).
const config = [
  { ignores: ['.next/**', 'next-env.d.ts'] },
  ...coreWebVitals,
  ...typescript,
];

export default config;
