# Radar de Vagas + Hermes Agent

Dashboard web leve para organizar descoberta de vagas, prazos, currículos ATS e candidaturas. A interface é HTML5/CSS puro com TypeScript empacotado, e o backend usa SQLite nativo do Node 24.

## Rodar localmente

```bash
npm install
npm run build
npm start
```

Abra `http://localhost:8787`.

Para desenvolvimento com recarga do TypeScript, use `npm run dev`.

## Rodar no Docker

```bash
docker compose up -d --build
```

O banco persistirá no volume `radar_data` e o painel ficará em `http://localhost:8787`.

## Integração com Hermes

O painel recebe eventos no endpoint `POST /api/agent-events`:

```json
{
  "event": "job.discovered",
  "job": {
    "title": "Analista de EHS",
    "company": "Empresa",
    "location": "São Paulo, SP",
    "source": "Portal autorizado",
    "source_url": "https://exemplo.com/vaga",
    "opening_status": "open",
    "deadline_at": "2026-10-01T23:59:00.000Z",
    "salary_min": 6500,
    "salary_max": 8500,
    "salary_source": "API/URL autorizada",
    "salary_source_url": "https://exemplo.com/salario"
  }
}
```

Também são aceitos `job.updated` e `agent.status`. O contrato mantém origem, URL, prazo, status de abertura e fonte salarial para auditoria.

## Regras do ciclo de vida

- Uma candidatura enviada deve ser registrada como `submitted`; o painel grava a data e calcula há quantos dias ela foi feita.
- Se o prazo passar ou a fonte informar fechamento sem candidatura enviada, a vaga vira `expired` e aparece como **Vaga perdida**.
- `not_interested` é uma decisão diferente de vaga perdida e fica visível separadamente.
- O dashboard não faz scraping do LinkedIn ou do Glassdoor. Para LinkedIn, use alertas/notificações e links ou textos trazidos para o painel. Para Glassdoor, use API, autorização, URL ou conferência manual, guardando fonte, confiança e data.
- O botão de candidatura registra o envio confirmado pelo usuário. A automação futura deve permanecer assistida ou depender de integração explicitamente autorizada pelo portal.

Os registros demonstrativos exibidos no primeiro acesso são fictícios e podem ser removidos quando você começar a alimentar o banco real.
