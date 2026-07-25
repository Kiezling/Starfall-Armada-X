/// <reference types="vite/client" />

/** Short commit SHA of the build, injected by vite.config.ts. `'dev'` outside a git checkout. */
declare const __BUILD_SHA__: string;
/** ISO timestamp of when the build ran, injected by vite.config.ts. */
declare const __BUILD_TIME__: string;
