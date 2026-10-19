// Respostas de exemplo das APIs públicas dos ATS (formato observado, reduzido). Os testes de contrato
// usam estas cargas e variações com campos ausentes, renomeados ou extras.

export const greenhouse = {
  jobs: [
    {
      absolute_url: "https://boards.greenhouse.io/exemplo/jobs/4001?gh_src=abc",
      data_compliance: [],
      internal_job_id: 9001,
      location: { name: "São Paulo, Brasil (Remote)" },
      metadata: null,
      id: 4001,
      updated_at: "2026-10-01T12:00:00-04:00",
      requisition_id: "R-1",
      title: "Engenheira de Dados Sênior",
      company_name: "Exemplo Tech",
      first_published: "2026-09-20T10:00:00-04:00",
      content: "&lt;p&gt;Você vai construir &lt;strong&gt;pipelines&lt;/strong&gt; de dados em larga escala, com qualidade, observabilidade e governança. O time cuida de ingestão, modelagem e disponibilização para análise e produtos de dados.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;li&gt;SQL&lt;/li&gt;&lt;/ul&gt;",
      departments: [{ id: 1, name: "Dados" }],
      offices: [{ id: 2, name: "Remote" }]
    },
    { absolute_url: "https://boards.greenhouse.io/exemplo/jobs/4002", id: 4002, title: "Analista de Produto", location: { name: "Rio de Janeiro" }, updated_at: "2026-10-02T12:00:00Z", content: "" },
    { id: 4003, title: "", absolute_url: "https://boards.greenhouse.io/exemplo/jobs/4003" },
    { id: 4004, title: "Vaga sem URL" },
    { id: 4005, title: "Vaga com URL http", absolute_url: "http://boards.greenhouse.io/exemplo/jobs/4005" },
    { id: 4006, title: "Vaga em host privado", absolute_url: "https://127.0.0.1/jobs/4006" }
  ],
  meta: { total: 6 }
};

export const lever = [
  {
    additional: "<p>Contratação CLT.</p>",
    additionalPlain: "Contratação CLT.",
    categories: { commitment: "Full-time", department: "Engenharia", location: "Curitiba, PR", team: "Plataforma", allLocations: ["Curitiba, PR"] },
    createdAt: 1759320000000,
    descriptionPlain: "Buscamos pessoa desenvolvedora backend para evoluir nossa plataforma de pagamentos, com foco em confiabilidade, escalabilidade e boas práticas de engenharia de software em equipe.",
    description: "<div>Buscamos pessoa desenvolvedora backend</div>",
    id: "a1b2c3d4-0000-4000-8000-000000000001",
    lists: [
      { text: "Requisitos", content: "<li>Node.js</li><li>PostgreSQL</li>" },
      { text: "Responsabilidades", content: "<li>Projetar APIs</li>" },
      { text: "Benefícios", content: "<li>Vale-refeição</li>" }
    ],
    text: "Desenvolvedora Backend Pleno",
    country: "BR",
    workplaceType: "hybrid",
    hostedUrl: "https://jobs.lever.co/exemplo/a1b2c3d4-0000-4000-8000-000000000001",
    applyUrl: "https://jobs.lever.co/exemplo/a1b2c3d4-0000-4000-8000-000000000001/apply",
    salaryRange: { currency: "BRL", interval: "per-month-salary", min: 9000, max: 12000 },
    campoNovo: { qualquer: true }
  },
  {
    id: "a1b2c3d4-0000-4000-8000-000000000002",
    text: "Designer de Produto",
    categories: { location: "Remoto" },
    workplaceType: "unspecified",
    hostedUrl: "https://jobs.lever.co/exemplo/a1b2c3d4-0000-4000-8000-000000000002",
    salaryRange: { currency: "BRL", interval: "per-month-salary", min: 15000, max: 9000 }
  }
];

export const ashby = {
  apiVersion: "1",
  jobs: [
    {
      title: "Cientista de Dados",
      location: "Remote - Brazil",
      department: "Data",
      isListed: true,
      isRemote: true,
      workplaceType: "Remote",
      descriptionHtml: "<p>Modelos de ML em produção.</p>",
      descriptionPlain: "Modelos de ML em produção para recomendação e previsão de demanda, trabalhando com engenharia de dados, produto e times de negócio para medir impacto real em experimentos controlados.",
      publishedAt: "2026-09-30T15:00:00.000+00:00",
      employmentType: "FullTime",
      jobUrl: "https://jobs.ashbyhq.com/exemplo/11111111-2222-3333-4444-555555555555",
      applyUrl: "https://jobs.ashbyhq.com/exemplo/11111111-2222-3333-4444-555555555555/application",
      compensation: { summaryComponents: [{ compensationType: "Salary", interval: "1 YEAR", currencyCode: "USD", minValue: 60000, maxValue: 80000 }] }
    },
    { title: "Vaga oculta", isListed: false, jobUrl: "https://jobs.ashbyhq.com/exemplo/oculta" }
  ]
};

export const gupy = {
  data: [
    {
      id: 7001,
      companyId: 55,
      name: "Analista de Dados Pleno",
      description: "<p>Análise de dados de varejo.</p>",
      careerPageId: 99,
      careerPageName: "Varejo Exemplo",
      careerPageUrl: "https://varejo.gupy.io",
      type: "vacancy_type_effective",
      publishedDate: "2026-10-05T13:00:00.000Z",
      applicationDeadline: "2026-11-05",
      isRemoteWork: false,
      city: "Belo Horizonte",
      state: "Minas Gerais",
      country: "Brasil",
      jobUrl: "https://varejo.gupy.io/jobs/7001?jobBoardSource=gupy_portal",
      workplaceType: "hybrid",
      badges: { friendlyBadge: false }
    },
    { id: 7002, name: "Analista de Dados Júnior", careerPageName: "Outra Empresa", jobUrl: "https://outra.gupy.io/jobs/7002?jobBoardSource=gupy_portal", workplaceType: "remote" }
  ],
  pagination: { offset: 0, limit: 100, total: 2 }
};

export const smartrecruiters = {
  offset: 0,
  limit: 100,
  totalFound: 1,
  content: [
    {
      id: "744000012345678",
      name: "Engenheiro de Software",
      uuid: "6f1c-0000",
      refNumber: "REF1",
      company: { identifier: "ExemploSA", name: "Exemplo SA" },
      releasedDate: "2026-10-03T10:00:00.000Z",
      location: { city: "Porto Alegre", region: "RS", country: "br", remote: false, hybrid: true, fullLocation: "Porto Alegre, RS, Brasil" },
      experienceLevel: { id: "mid_senior_level", label: "Pleno-sênior" },
      typeOfEmployment: { label: "Full-time" }
    }
  ]
};

export const workable = {
  name: "Startup Exemplo",
  description: null,
  jobs: [
    {
      title: "Product Manager",
      shortcode: "ABC123",
      code: "",
      employment_type: "Full-time",
      telecommuting: true,
      department: "Produto",
      url: "https://apply.workable.com/j/ABC123",
      shortlink: "https://apply.workable.com/j/ABC123",
      application_url: "https://apply.workable.com/j/ABC123/apply",
      published_on: "2026-10-04",
      created_at: "2026-10-01",
      country: "Brazil",
      city: "Recife",
      state: "Pernambuco",
      experience: "Mid-Senior level",
      locations: [{ country: "Brazil", countryCode: "BR", city: "Recife", region: "Pernambuco", hidden: false }]
    }
  ]
};

const longText = "Responsabilidades: desenvolver serviços, revisar código, colaborar com produto e dados, garantir qualidade, observabilidade e segurança em produção. ".repeat(3);

/** Página de vaga com JSON-LD JobPosting dentro de @graph. */
export const jsonLdPage = `<!doctype html><html><head><title>Vaga</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Exemplo SA"},{"@type":"JobPosting","title":"Engenheiro de Software","description":"<p>${longText}</p>","datePosted":"2026-10-03","validThrough":"2026-12-01T00:00:00Z","employmentType":"FULL_TIME","jobLocationType":"TELECOMMUTE","hiringOrganization":{"@type":"Organization","name":"Exemplo SA"},"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Porto Alegre","addressRegion":"RS","addressCountry":"BR"}},"baseSalary":{"@type":"MonetaryAmount","currency":"BRL","value":{"@type":"QuantitativeValue","minValue":10000,"maxValue":14000,"unitText":"MONTH"}}}]}</script>
<script>alert("ignorado")</script></head><body><h1>Engenheiro</h1></body></html>`;

/** Página sem JSON-LD, mas com contêiner de descrição conhecido. */
export const selectorPage = `<!doctype html><html><head><meta name="description" content="curta"></head><body>
<div class="header">Topo</div><div class="job-description"><h2>Sobre a vaga</h2><div><p>${longText}</p></div><ul><li>Item A</li></ul></div><footer>Rodapé</footer></body></html>`;

/** Página sem nada aproveitável: vai para a fila de LLM. */
export const emptyPage = `<!doctype html><html><head><script type="application/ld+json">{malformado</script></head><body><div id="app"></div></body></html>`;
