/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// fontsource packages are side-effect-only imports with no type declarations
declare module '@fontsource-variable/inter'
declare module '@fontsource-variable/*'

declare const __APP_BUILD__: { id: string; builtAt: string }
