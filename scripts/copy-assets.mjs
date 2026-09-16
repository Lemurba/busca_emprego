import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/public", { recursive: true });
await cp("public/index.html", "dist/public/index.html");
await cp("public/styles.css", "dist/public/styles.css");
await cp("public/favicon.svg", "dist/public/favicon.svg");
