/**
 * Portal de candidatura de mentira, para provar o caminho do executor autorizado.
 *
 * Serve um formulário com os mesmos obstáculos de um portal real (campos de texto,
 * upload de arquivo, consentimento obrigatório) e responde com um redirect para uma
 * página de confirmação com protocolo — exatamente o que o executor precisa capturar
 * como evidência.
 *
 * Uso: node test/fixtures/portal-fixture.mjs [porta]
 *   GET  /vaga/:slug/aplicar       → formulário
 *   POST /vaga/:slug/aplicar       → valida e redireciona (303) para /vaga/:slug/confirmado?protocolo=…
 *   GET  /vaga/:slug/confirmado    → confirmação com protocolo
 *   POST /__submissions            → inspeção das submissões recebidas (usado em teste)
 *
 * O formulário exige: nome, e-mail, telefone, arquivo .pdf e o consentimento marcado.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const port = Number(process.argv[2] ?? 0);
const submissions = [];

const page = (title, body) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:2rem auto">
<h1>${title}</h1>${body}</body></html>`;

const form = (slug) => page("Candidatura — Portal Exemplo", `
<form method="post" action="/vaga/${slug}/aplicar" enctype="multipart/form-data" id="application-form">
  <p><label>Nome completo <input name="nome" id="nome" required></label></p>
  <p><label>E-mail <input name="email" id="email" type="email" required></label></p>
  <p><label>Telefone <input name="telefone" id="telefone" required></label></p>
  <p><label>Currículo (PDF) <input name="curriculo" id="curriculo" type="file" accept="application/pdf" required></label></p>
  <p><label><input type="checkbox" name="consentimento" id="consentimento" value="sim" required> Autorizo o tratamento dos meus dados</label></p>
  <p><button type="submit" id="enviar">Enviar candidatura</button></p>
</form>`);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const match = url.pathname.match(/^\/vaga\/([^/]+)\/(aplicar|confirmado)$/u);

  if (req.method === "POST" && url.pathname === "/__submissions") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(submissions));
    return;
  }
  if (req.method === "GET" && url.pathname === "/__submissions") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(submissions));
    return;
  }
  if (req.method === "GET" && match && match[2] === "aplicar") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(form(match[1]));
    return;
  }
  if (req.method === "GET" && match && match[2] === "confirmado") {
    const protocolo = url.searchParams.get("protocolo") ?? "";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page("Candidatura enviada", `<p id="protocolo">Protocolo: <strong>${protocolo}</strong></p>
<p>Candidatura registrada para a vaga ${match[1]}.</p>`));
    return;
  }
  if (req.method === "POST" && match && match[2] === "aplicar") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const hasPdf = /filename="[^"]+\.pdf"/iu.test(raw) || /application\/pdf/iu.test(raw);
      const hasConsent = /name="consentimento"/u.test(raw);
      const nome = raw.match(/name="nome"\r?\n\r?\n([^\r\n]*)/u)?.[1] ?? "";
      const email = raw.match(/name="email"\r?\n\r?\n([^\r\n]*)/u)?.[1] ?? "";
      if (!hasPdf || !hasConsent || !nome || !email) {
        res.writeHead(422, { "content-type": "text/html; charset=utf-8" });
        res.end(page("Candidatura recusada", `<p id="motivo">Faltou currículo em PDF, consentimento, nome ou e-mail.</p>`));
        return;
      }
      const protocolo = `PF-${randomBytes(4).toString("hex").toUpperCase()}`;
      submissions.push({ slug: match[1], nome, email, hasPdf, hasConsent, protocolo, at: new Date().toISOString() });
      res.writeHead(303, { location: `/vaga/${match[1]}/confirmado?protocolo=${protocolo}` });
      res.end();
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("não encontrado");
});

server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  console.log(JSON.stringify({ ok: true, port: address.port, base: `http://127.0.0.1:${address.port}` }));
});
