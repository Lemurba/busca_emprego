// Subcaminho público do dashboard (RADAR_BASE_PATH), p.ex. atrás do nginx em /plugins/busca-emprego/.
// O proxy pode ou não remover o prefixo antes de repassar; o servidor aceita as duas formas.

/** Normaliza para "/" ou "/a/b/" (sempre com barra no início e no fim). */
export function normalizeBasePath(value: string | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "/") return "/";
  if (!/^[A-Za-z0-9._~\-/]+$/u.test(raw) || raw.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`RADAR_BASE_PATH inválido: ${raw} (use algo como /plugins/busca-emprego/)`);
  }
  const trimmed = raw.replace(/^\/+|\/+$/gu, "").replace(/\/{2,}/gu, "/");
  return trimmed ? `/${trimmed}/` : "/";
}

/** Path do cookie: sem a barra final, para valer também no próprio prefixo ("/a/b" casa "/a/b/..."). */
export function cookiePath(basePath: string): string {
  return basePath === "/" ? "/" : basePath.replace(/\/$/u, "");
}

/** Remove o prefixo quando o proxy o repassa; caminhos sem o prefixo ficam como estão. */
export function stripBasePath(pathname: string, basePath: string): string {
  if (basePath === "/") return pathname;
  const prefix = basePath.slice(0, -1);
  if (pathname === prefix) return "/";
  return pathname.startsWith(basePath) ? pathname.slice(prefix.length) : pathname;
}

/** Ajusta o <base href> do index.html para o subcaminho configurado. */
export function withBaseHref(html: string, basePath: string): string {
  return html.replace(/<base href="[^"]*"\s*\/?>/u, `<base href="${basePath}" />`);
}
