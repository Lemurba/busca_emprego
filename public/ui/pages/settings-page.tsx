/**
 * Página "Configurações" em Preact (antes era `renderSettings()` em app.ts).
 *
 * Mesmas classes, textos e atributos `data-*` da versão em string: Editar fonte, + Fonte,
 * Restaurar e Abrir agentes continuam tratados pela delegação do #view (`handleAction`).
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
export type SettingsPref = "map" | "browser-ai";

export type SettingsPageProps = {
  title: string;
  sourceTypeLabel: (type: string) => string;
  authLabel: (strategy: string) => string;
  formatDate: (value: string | null | undefined) => string;
  /** Liga/desliga uma preferência deste navegador (estado, localStorage e aviso ficam em app.ts). */
  onPrefChange: (pref: SettingsPref, checked: boolean) => void;
  connectors: ConnectorPanelDeps;
};

function SourceRow({ source, sourceTypeLabel, authLabel }: { source: SourceConfig } & Pick<SettingsPageProps, "sourceTypeLabel" | "authLabel">) {
  return (
    <tr>
      <td><strong>{source.name}</strong><br /><small>{source.domain}</small></td>
      <td>{sourceTypeLabel(source.source_type)}</td>
      <td>{authLabel(source.auth_strategy)}</td>
      <td><span class={`status-pill ${source.enabled ? "teal" : "neutral"}`}>{source.enabled ? "Ativa" : "Pausada"}</span></td>
      <td><button type="button" class="secondary-button" data-edit-source={source.id} aria-label={`Editar ${source.name}`}>Editar</button></td>
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

export function SettingsPage({ title, sourceTypeLabel, authLabel, formatDate, onPrefChange, connectors }: SettingsPageProps) {
  const data = appData();
  const { mapEnabled, browserAiTools } = appState();
  const archived = data.archivedJobs ?? [];
  return (
    <>
      <PageHeading title={title} subtitle="Fontes de vagas, privacidade e integrações deste navegador." />
      <section class="panel">
        <div class="section-head flush">
          <div><h2>Fontes e credenciais</h2><p>Senhas e tokens ficam no Hermes; aqui só há referências.</p></div>
          <button type="button" class="primary-button" data-action="add-source"><span aria-hidden="true">+</span> Fonte</button>
        </div>
        <table class="source-table">
          <thead><tr><th>Fonte</th><th>Tipo</th><th>Acesso</th><th>Estado</th><th><span class="visually-hidden">Ações</span></th></tr></thead>
          <tbody>
            {data.sourceConfigs.length
              ? data.sourceConfigs.map((source) => <SourceRow key={source.id} source={source} sourceTypeLabel={sourceTypeLabel} authLabel={authLabel} />)
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
