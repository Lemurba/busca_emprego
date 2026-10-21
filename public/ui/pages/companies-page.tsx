/**
 * Página "Empresas" em Preact (antes era `renderCompanies()` em app.ts).
 *
 * Mesmas classes e textos da versão em string; a página não tem ações próprias.
 * O cálculo do salário médio e a formatação de moeda continuam em app.ts (props).
 */
import type { Data } from "../../app.js";
import { appData } from "../app-state.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeading } from "../components/page-heading.js";

type Job = Data["jobs"][number];
type Company = Data["companies"][number];
type SalaryAverage = { value: number; currency: string; count: number } | null;

export type CompaniesPageProps = {
  title: string;
  averageMonthlySalary: (jobs: Job[]) => SalaryAverage;
  formatMoney: (value: number | null, currency?: string) => string;
};

function CompanyCard({ company, salary, formatMoney }: { company: Company; salary: SalaryAverage; formatMoney: CompaniesPageProps["formatMoney"] }) {
  return (
    <article class="company-card">
      <div class="company-top">
        <div class="company-logo" aria-hidden="true">{company.name.slice(0, 1).toUpperCase()}</div>
        <span class="chip">{company.jobs} vaga{company.jobs === 1 ? "" : "s"}</span>
      </div>
      <div>
        <h3>{company.name}</h3>
        <p>{company.locations.join(" · ")}</p>
      </div>
      <div class="company-stat">
        <div>
          <span>Salário médio</span>
          <strong>{salary ? `${formatMoney(salary.value, salary.currency)}/mês` : "Não informado"}</strong>
          {salary ? <small>estimado em {salary.count} vaga{salary.count === 1 ? "" : "s"}</small> : null}
        </div>
        <div><span>Fontes</span><strong>{company.sources.length}</strong></div>
      </div>
      <div class="tag-list">
        {company.sources.map((source) => <span key={source} class="tag">{source}</span>)}
      </div>
    </article>
  );
}

export function CompaniesPage({ title, averageMonthlySalary, formatMoney }: CompaniesPageProps) {
  const data = appData();
  const jobsByCompany = new Map<string, Job[]>();
  for (const job of data.jobs) jobsByCompany.set(job.company, [...(jobsByCompany.get(job.company) ?? []), job]);
  return (
    <>
      <PageHeading title={title} subtitle="Compare concentração de vagas, localidades e salários médios registrados." />
      <div class="company-grid">
        {data.companies.length
          ? data.companies.map((company) => (
            <CompanyCard key={company.name} company={company} salary={averageMonthlySalary(jobsByCompany.get(company.name) ?? [])} formatMoney={formatMoney} />
          ))
          : <EmptyState title="Nenhuma empresa ainda" detail="As empresas aparecem conforme as vagas chegam." />}
      </div>
    </>
  );
}
