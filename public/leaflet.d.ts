// O dashboard usa o Leaflet empacotado pelo esbuild como `any` (ver public/app.ts); este shim
// só permite o typecheck de public/ sem acrescentar @types/leaflet.
declare module "leaflet";
