import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/public", { recursive: true });
await cp("public/index.html", "dist/public/index.html");
await cp("public/styles.css", "dist/public/styles.css");
await cp("public/favicon.svg", "dist/public/favicon.svg");
// Leaflet servido localmente (CSP sem CDN): o JS entra no bundle do esbuild; CSS e imagens são copiados.
await mkdir("dist/public/vendor/leaflet", { recursive: true });
await cp("node_modules/leaflet/dist/leaflet.css", "dist/public/vendor/leaflet/leaflet.css");
await cp("node_modules/leaflet/dist/images", "dist/public/vendor/leaflet/images", { recursive: true });
