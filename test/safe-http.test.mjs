/**
 * Cliente HTTP seguro único (src/safe-http.ts), usado pelos conectores e pela verificação de
 * vaga aberta: DNS fixado contra rebinding, corpo em streaming com limite e tempo.
 * Sem internet: o DNS é falso e os corpos são streams locais.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConnectorHttpClient, ConnectorHttpError } from "../src/connectors/http.ts";
import { pinnedHttpsFetch, pinnedLookup, readBodyCapped, safeFetch, SafeHttpError } from "../src/safe-http.ts";

const PUBLIC = { address: "93.184.216.34", family: 4 };
const PRIVATE = { address: "10.0.0.7", family: 4 };

/** Stream infinito que conta quantos pedaços foram pedidos. */
function endlessBody(chunkSize = 1024) {
  const state = { pulls: 0 };
  const stream = new ReadableStream({
    pull(controller) { state.pulls += 1; controller.enqueue(new Uint8Array(chunkSize).fill(120)); },
    cancel() { state.cancelled = true; }
  });
  return { stream, state };
}

/** Stream que entrega um pedaço e depois trava (servidor lento). */
function stalledBody() {
  return new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
    pull() { return new Promise(() => {}); }
  });
}

describe("DNS fixado (anti-rebinding)", () => {
  test("resolve uma vez e entrega ao transporte só os IPs validados", async () => {
    // DNS de rebinding: a 1ª resposta é pública, as seguintes apontam para a rede interna.
    let queries = 0;
    const rebinding = async () => (queries++ === 0 ? [PUBLIC] : [PRIVATE]);
    let received;
    const fetch = async (_url, _init, pinned) => { received = pinned; return new Response("ok"); };
    const response = await safeFetch(new URL("https://vagas.example.com/x"), { method: "GET" }, { fetch, lookup: rebinding });
    assert.equal(await response.text(), "ok");
    assert.equal(queries, 1, "uma única consulta DNS por requisição");
    assert.deepEqual(received, [PUBLIC], "o transporte recebe os IPs já validados");
  });

  test("qualquer IP privado na resolução recusa sem chamar o transporte", async () => {
    let fetched = 0;
    const fetch = async () => { fetched += 1; return new Response("x"); };
    for (const addresses of [[PRIVATE], [PUBLIC, PRIVATE], [{ address: "::1", family: 6 }], [{ address: "169.254.169.254", family: 4 }], []]) {
      await assert.rejects(safeFetch(new URL("https://x.example.com/"), {}, { fetch, lookup: async () => addresses }), (error) => error instanceof SafeHttpError && error.kind === "refused");
    }
    await assert.rejects(safeFetch(new URL("http://x.example.com/"), {}, { fetch, lookup: async () => [PUBLIC] }), /HTTPS/u);
    await assert.rejects(safeFetch(new URL("https://127.0.0.1/"), {}, { fetch, lookup: async () => [PUBLIC] }), /privado/u);
    assert.equal(fetched, 0);
  });

  test("falha de DNS vira erro de rede; DNS lento respeita o tempo", async () => {
    await assert.rejects(safeFetch(new URL("https://x.example.com/"), {}, { lookup: async () => { throw new Error("ENOTFOUND"); } }), (error) => error.kind === "network");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(safeFetch(new URL("https://x.example.com/"), { signal: controller.signal }, { lookup: () => new Promise(() => {}) }), (error) => error.kind === "timeout");
  });

  test("o lookup do socket não consulta o DNS: só devolve os IPs fixados", async () => {
    const lookup = pinnedLookup([PUBLIC, { address: "2606:2800:220:1::1", family: 6 }]);
    const single = await new Promise((resolve) => lookup("qualquer.example.com", { family: 6 }, (error, address, family) => resolve({ error, address, family })));
    assert.deepEqual(single, { error: null, address: "2606:2800:220:1::1", family: 6 });
    const all = await new Promise((resolve) => lookup("qualquer.example.com", { all: true }, (_error, list) => resolve(list)));
    assert.deepEqual(all.map((item) => item.address), [PUBLIC.address, "2606:2800:220:1::1"]);
    const refused = await new Promise((resolve) => pinnedLookup([PUBLIC, PRIVATE])("x", {}, (error) => resolve(error)));
    assert.ok(refused instanceof SafeHttpError && refused.kind === "refused");
  });

  test("transporte padrão conecta no IP fixado, não no nome", async () => {
    // O nome não existe no DNS: se o transporte resolvesse de novo, o erro seria de rede.
    // Com o IP fixado (privado de propósito), a conexão é recusada pelo lookup fixado.
    await assert.rejects(pinnedHttpsFetch("https://nao-existe.invalid/", { method: "GET" }, [PRIVATE]), (error) => error instanceof SafeHttpError && error.kind === "refused");
    await assert.rejects(pinnedHttpsFetch("http://x.example.com/", { method: "GET" }, [PUBLIC]), /HTTPS/u);
  });
});

describe("corpo em streaming com limite", () => {
  test("modo erro: para no limite sem ler o resto (corpo infinito)", async () => {
    const { stream, state } = endlessBody(1024);
    await assert.rejects(readBodyCapped(new Response(stream), 4096, { onLimit: "error" }), (error) => error.kind === "too_large");
    assert.ok(state.pulls <= 8, `leu ${state.pulls} pedaços`);
    assert.equal(state.cancelled, true, "o stream é cancelado");
  });

  test("modo erro: content-length acima do limite é recusado sem ler", async () => {
    const { stream, state } = endlessBody(1024);
    const response = new Response(stream, { headers: { "content-length": "999999" } });
    await assert.rejects(readBodyCapped(response, 4096, { onLimit: "error" }), (error) => error.kind === "too_large");
    assert.ok(state.pulls <= 1);
  });

  test("modo corte: devolve exatamente o prefixo e marca truncated", async () => {
    const { stream } = endlessBody(1000);
    const read = await readBodyCapped(new Response(stream), 2500, { onLimit: "truncate" });
    assert.equal(read.bytes.byteLength, 2500);
    assert.equal(read.truncated, true);
    const small = await readBodyCapped(new Response("abc"), 2500);
    assert.deepEqual([new TextDecoder().decode(small.bytes), small.truncated], ["abc", false]);
  });

  test("leitura travada aborta pelo sinal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(readBodyCapped(new Response(stalledBody()), 4096, { signal: controller.signal }), (error) => error.kind === "timeout");
  });
});

describe("cliente dos conectores usa o transporte seguro", () => {
  const client = (fetchImpl, options = {}) => new ConnectorHttpClient({ fetchImpl, lookup: async () => [PUBLIC], baseDelayMs: 0, sleep: async () => {}, ...options });

  test("DNS privado: recusa sem retentativa e sem buscar", async () => {
    let fetched = 0;
    let queries = 0;
    const http = client(async () => { fetched += 1; return new Response("{}"); }, { lookup: async () => { queries += 1; return [PRIVATE]; } });
    await assert.rejects(http.getJson("https://interno.example.com/"), (error) => error instanceof ConnectorHttpError && error.code === "connector.destination.private");
    assert.equal(fetched, 0);
    assert.equal(queries, 1, "destino privado não é retentado");
  });

  test("redirecionamento: cada salto é resolvido e validado de novo", async () => {
    const lookup = async (host) => (host === "interno.example.com" ? [PRIVATE] : [PUBLIC]);
    const http = client(async (url) => (url.includes("publico") ? new Response(null, { status: 302, headers: { location: "https://interno.example.com/" } }) : new Response("segredo")), { lookup });
    await assert.rejects(http.getText("https://publico.example.com/"), (error) => error.code === "connector.destination.private");
  });

  test("corpo maior que o limite é recusado durante a leitura", async () => {
    const { stream, state } = endlessBody(1024);
    const http = client(async () => new Response(stream), { maxBodyBytes: 4096 });
    await assert.rejects(http.getText("https://grande.example.com/"), (error) => error.code === "connector.response.too_large");
    assert.ok(state.pulls <= 8);
  });

  test("corpo travado respeita o timeout da requisição", async () => {
    const http = client(async () => new Response(stalledBody()), { requestTimeoutMs: 30 });
    await assert.rejects(http.getText("https://lento.example.com/"), (error) => error.code === "connector.request_timeout");
  });

  test("o transporte recebe os IPs fixados", async () => {
    let pinned;
    const http = client(async (_url, _init, addresses) => { pinned = addresses; return new Response("{}"); });
    await http.getJson("https://api.example.com/");
    assert.deepEqual(pinned, [PUBLIC]);
  });
});
