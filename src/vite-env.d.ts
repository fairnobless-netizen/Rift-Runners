/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEBUG_UI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
