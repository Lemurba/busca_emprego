/**
 * Sessão do dashboard para testes contra o servidor real: decisões humanas (AUTORIZO, ENVIAR,
 * kill-switch) só passam com o cookie de sessão, nunca com o token de serviço (#32).
 */
export async function dashboardSession(base, dashboardToken, headers = {}) {
  const response = await fetch(`${base}/auth?token=${encodeURIComponent(dashboardToken)}`, { redirect: "manual", headers });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  if (response.status !== 303 || !cookie.startsWith("radar_session=")) throw new Error(`login do dashboard falhou: HTTP ${response.status}`);
  return cookie;
}

/** Cliente JSON com o cookie de sessão (sem token de serviço). */
export function sessionClient(base, cookie, headers = {}) {
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await response.json(); } catch { /* sem corpo JSON */ }
    return { status: response.status, data };
  };
}
