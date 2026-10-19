import type { ConnectorHttpClient } from "./http.js";

/** Item no formato aceito por ingestRoundBatch (src/db.ts → validateSourceBatch). */
export interface ConnectorItem {
  source_id: string;
  source_job_id: string | null;
  title: string;
  company: string;
  location_text?: string | null;
  work_model?: string | null;
  seniority?: string | null;
  description?: string | null;
  requirements?: string[] | null;
  responsibilities?: string[] | null;
  benefits?: string[] | null;
  additional_information?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  currency?: string | null;
  salary_period?: "hour" | "month" | "year" | null;
  posted_at?: string | null;
  deadline_at?: string | null;
  opening_status: "open" | "closed" | "unknown";
  source_url: string;
  job_url: string;
  application_url?: string | null;
  evidence_refs?: string[];
}

export interface ConnectorCompanyRef {
  slug: string;
  name: string;
  /** Termo de busca opcional (só a Gupy usa: o portal público busca por cargo). */
  query?: string;
}

export interface ConnectorFetchResult {
  items: ConnectorItem[];
  /** Registros recebidos que não viraram item (campos obrigatórios ausentes, URL inválida…). */
  skipped: number;
}

export interface ConnectorDefinition {
  /** Igual ao id da fonte em source_configs (fontes padrão de agent-defaults.ts). */
  id: string;
  name: string;
  /** Formato aceito para o identificador da empresa no ATS. */
  slugPattern: RegExp;
  /** Exemplo exibido no painel. */
  slugHint: string;
  fetchCompany(client: ConnectorHttpClient, company: ConnectorCompanyRef): Promise<ConnectorFetchResult>;
}
