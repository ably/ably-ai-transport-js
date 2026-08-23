import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

// Flat config (ESLint 9 / Next 16). `next lint` was removed in Next 16, so the
// `lint` script runs eslint directly against this config, which composes
// next/core-web-vitals and next/typescript (the rules the old .eslintrc used).
const config = [
  { ignores: ['.next/**', 'next-env.d.ts'] },
  ...coreWebVitals,
  ...typescript,
  {
    // chat.tsx runs an effect that synchronises React with an external system —
    // exactly what effects are for: it appends a status-transition entry
    // whenever the folded run status changes. The React-Compiler rule
    // react-hooks/set-state-in-effect can't tell this apart from accidental
    // cascading setState. Scope the rule off to just this file rather than
    // suppress inline.
    files: ['src/app/components/chat.tsx'],
    rules: { 'react-hooks/set-state-in-effect': 'off' },
  },
];

export default config;
