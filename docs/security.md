# Segurança para uso na rede doméstica

O Radar não possui módulo de autenticação, login, token de acesso, chave da API ou escopos HTTP. `src/auth.ts` foi removido. Todas as rotas do dashboard e da API ficam acessíveis a qualquer dispositivo que alcance `0.0.0.0:8787`.

Isso significa que qualquer pessoa, aplicativo ou dispositivo comprometido na mesma rede pode visualizar currículos e vagas, alterar agentes e fontes, excluir dados ou registrar comandos. A fronteira de acesso é o roteador/firewall da rede doméstica, não o aplicativo.

## Regras de rede

- Permita TCP 8787 somente para a sub-rede doméstica confiável.
- Não crie port forwarding, UPnP, túnel público ou regra WAN para essa porta.
- Não use a rede de convidados ou Wi-Fi público para acessar o Radar.
- Para acesso remoto, use VPN privada; não publique o Radar diretamente na internet.
- `RADAR_TRUST_PROXY_TLS=false` permite HTTP direto dentro da LAN. Se usar o proxy TLS do Hermes, defina `true` e mantenha a porta 8787 inacessível fora do host/proxy.

O script `scripts/ops/verify-environment.mjs` aceita HTTPS ou HTTP apenas para localhost, `.local` e endereços privados. Ele confirma que `/api/bootstrap` funciona sem credencial.

## Controles que permanecem

A remoção da autenticação HTTP não remove os limites funcionais:

- candidatura automática ainda exige `AUTORIZO` para vaga, currículo, versão e URL exatos;
- `APROVO` não equivale a `AUTORIZO`;
- agentes continuam limitados por papel, `tool_scopes`, `allowed_domains` e campos editáveis;
- Browser Harness de leitura continua separado do executor de candidatura;
- CAPTCHA e bloqueios nunca são contornados;
- dúvidas continuam bloqueadas até resposta da identidade Telegram vinculada ao Hermes;
- fontes guardam somente `secret_ref` ou `browser_profile_id`, nunca senha, cookie ou token bruto.

As respostas HTTP continuam com CSP, `frame-ancestors 'none'`, `nosniff`, política de permissões e referrer restritivo. Esses cabeçalhos reduzem riscos no navegador, mas não substituem autenticação nem firewall.
