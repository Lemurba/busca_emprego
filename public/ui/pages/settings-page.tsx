/**
 * Página "Configurações" em Preact (antes era `renderSettings()` em app.ts).
 *
 * Mesmas classes, textos e atributos `data-*` da versão em string: Editar fonte, + Fonte,
 * Restaurar e Abrir agentes continuam tratados pela delegação do #view (`handleAction`).
 * I49-07/§1.3: cada fonte mostra a prontidão CALCULADA (`effectiveReadiness`, a mesma da rodada)
 * com o motivo traduzido, e oferece Aceitar termos (portão humano), Registrar teste de acesso e
 * Excluir, todos pela delegação do #view (`data-action` + `data-source-id`).
 * Duas peças viraram handlers Preact, porque o DOM agora persiste entre renders:
 *   - os interruptores de privacidade (`data-pref`): antes `bindViewEvents()` religava um
 *     listener a cada render, o que com o diff do Preact acumularia listeners no mesmo input;
 *   - o painel "Empresas por conector" (ver connector-companies-panel.tsx).
 */
import type { Data } from "../../app.js";
import { appData, appState } from "../app-state.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeading } from "../components/page-heading.js";
import { ConnectorCompaniesPanel, type ConnectorPanelDeps } from "./connector-companies-panel.js";

type SourceConfig = Data["sourceConfigs"][number];
type Tone = { label: string; tone: string };
export type SettingsPref = "map" | "browser-ai";

export type SettingsPageProps = {
  title: string;
  sourceTypeLabel: (type: string) => string;
  authLabel: (strategy: string) => string;
  /** Rótulo e cor da prontidão calculada (pronta, não pronta, pausada...). */
  readiness: (status: string | null | undefined) => Tone;
  /** Motivo da prontidão em texto para a pessoa (códigos `source.*` traduzidos). */
  readinessReason: (reason: string | null | undefined) => string;
  formatDate: (value: string | null | undefined) => string;
  /** Liga/desliga uma preferência deste navegador (estado, localStorage e aviso ficam em app.ts). */
  onPrefChange: (pref: SettingsPref, checked: boolean) => void;
  connectors: ConnectorPanelDeps;
};

function SourceRow({ source, sourceTypeLabel, authLabel, readiness, readinessReason, formatDate }: { source: SourceConfig } & Pick<SettingsPageProps, "sourceTypeLabel" | "authLabel" | "readiness" | "readinessReason" | "formatDate">) {
  const effective = source.effectiveReadiness ?? { status: source.readiness_status ?? "configured", reason: source.readiness_reason ?? "" };
  const pill = readiness(effective.status);
  return (
    <tr data-source-row={source.id}>
      <td><strong>{source.name}</strong><br /><small>{source.domain}</small></td>
      <td>{sourceTypeLabel(source.source_type)}<br /><small>{authLabel(source.auth_strategy)}</small></td>
      <td>
        <span class={`status-pill ${pill.tone}`}>{pill.label}</span>
        <br /><small data-source-reason>{effective.status === "ready" ? `Teste de acesso em ${formatDate(source.last_smoke_test_at)}` : readinessReason(effective.reason)}</small>
      </td>
      <td>{source.terms_approved_at ? <>Aceitos<br /><small>{formatDate(source.terms_approved_at)}</small></> : "Não aceitos"}</td>
      <td class="source-actions">
        <div class="button-row">
          {source.terms_approved_at ? null : <button type="button" class="primary-button" data-action="accept-source-terms" data-source-id={source.id} aria-label={`Aceitar termos de ${source.name}`}>Aceitar termos…</button>}
          <button type="button" class="secondary-button" data-action="smoke-source" data-source-id={source.id} aria-label={`Registrar teste de acesso de ${source.name}`}>Registrar teste…</button>
          <button type="button" class="secondary-button" data-edit-source={source.id} aria-label={`Editar ${source.name}`}>Editar</button>
          <button type="button" class="text-button danger-text" data-action="delete-source" data-source-id={source.id} aria-label={`Excluir ${source.name}`}>Excluir…</button>
        </div>
      </td>
    </tr>
  );
}

function PrefToggle({ pref, checked, title, description, onChange }: { pref: SettingsPref; checked: boolean; title: string; description: string; onChange: SettingsPageProps["onPrefChange"] }) {
  return (
    <label class="setting-toggle">
      <span><strong>{title}</strong><small>{description}</small></span>
      <input type="checkbox" data-pref={pref} checked={checked} onChange={(event) => onChange(pref, event.currentTarget.checked)} />
    </label>
  );
}

export function SettingsPage({ title, sourceTypeLabel, authLabel, readiness, readinessReason, formatDate, onPrefChange, connectors }: SettingsPageProps) {
  const data = appData();
  const { mapEnabled, browserAiTools } = appState();
  const archived = data.archivedJobs ?? [];
  return (
    <>
      <PageHeading title={title} subtitle="Fontes de vagas, privacidade e integrações deste navegador." />
      <section class="panel">
        <div class="section-head flush">
          <div><h2>Fontes e credenciais</h2><p>Senhas e tokens ficam no Hermes; aqui só há referências. Uma fonte só entra nas buscas depois que você aceita os termos de uso dela e o teste de acesso passa.</p></div>
          <button type="button" class="primary-button" data-action="add-source"><span aria-hidden="true">+</span> Fonte</button>
        </div>
        <table class="source-table">
          <thead><tr><th>Fonte</th><th>Tipo e acesso</th><th>Prontidão</th><th>Termos de uso</th><th><span class="visually-hidden">Ações</span></th></tr></thead>
          <tbody>
            {data.sourceConfigs.length
              ? data.sourceConfigs.map((source) => <SourceRow key={source.id} source={source} sourceTypeLabel={sourceTypeLabel} authLabel={authLabel} readiness={readiness} readinessReason={readinessReason} formatDate={formatDate} />)
              : <tr><td colSpan={5}>Nenhuma fonte configurada.</td></tr>}
          </tbody>
        </table>
      </section>
      <ConnectorCompaniesPanel {...connectors} />
      <section class="panel section-spaced">
        <div class="section-head flush"><div><h2>Privacidade neste navegador</h2><p>Estas opções valem só para este navegador.</p></div></div>
        <div class="settings-toggles">
          <PrefToggle pref="map" checked={mapEnabled} title="Mostrar mapa" description="Carrega imagens do OpenStreetMap, que recebe seu IP e as regiões exibidas." onChange={onPrefChange} />
          <PrefToggle pref="browser-ai" checked={browserAiTools} title="Ferramentas para assistentes de IA do navegador" description="Permite que um assistente de IA do navegador liste suas vagas e as mova entre as etapas iniciais." onChange={onPrefChange} />
        </div>
      </section>
      <section class="panel section-spaced">
        <div class="section-head flush"><div><h2>Vagas excluídas</h2><p>Vagas excluídas não aparecem no painel nem voltam pelas buscas. Restaure quando quiser.</p></div></div>
        <div class="ops-list">
          {archived.length
            ? archived.map((job) => (
              <article key={job.id} class="ops-item">
                <div>
                  <strong>{job.title}</strong>
                  <span>{job.company} · excluída em {formatDate(job.archived_at)}{job.archived_reason ? ` · ${job.archived_reason}` : ""}</span>
                </div>
                <button type="button" class="secondary-button" data-action="restore-job" data-job-id={job.id}>Restaurar</button>
              </article>
            ))
            : <EmptyState title="Nenhuma vaga excluída" compact />}
        </div>
      </section>
      <section class="panel section-spaced">
        <div class="section-head flush">
          <div><h2>Agentes e integração com o Hermes</h2><p>Os agentes são criados e editados na página Agentes. A documentação técnica da integração fica em <code>docs/agent-api.md</code>.</p></div>
          <button type="button" class="secondary-button" data-page="agents">Abrir agentes</button>
        </div>
      </section>
    </>
  );
}
