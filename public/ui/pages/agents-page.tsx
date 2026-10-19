/**
 * Página "Agentes" em Preact (primeira tela migrada; antes era `renderAgents()` em app.ts).
 *
 * Mantém as mesmas classes, textos e atributos `data-*` da versão em string: os botões
 * Publicar/Versões/Editar/Novo agente continuam tratados pela delegação de eventos do
 * #view (`handleAction` em app.ts), sem handlers próprios aqui.
 */
import type { AgentConfig } from "../../app.js";
import { appData } from "../app-state.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeading } from "../components/page-heading.js";

/** Vocabulário que continua definido em app.ts (traduções de enums e nomes de fontes). */
export type AgentsPageProps = {
  title: string;
  roleLabel: (role: string) => string;
  sourceName: (sourceId: string) => string;
  fieldName: (field: string) => string;
};

function AgentCard({ agent, roleLabel, sourceName, fieldName }: { agent: AgentConfig } & Omit<AgentsPageProps, "title">) {
  return (
    <article class="company-card agent-card">
      <div class="company-top">
        <div>
          <h3>{agent.name}</h3>
          <p>{roleLabel(agent.role_type)}</p>
        </div>
        <div class="agent-setting-status">
          <span class={`status-pill ${agent.enabled ? "teal" : "neutral"}`}>{agent.enabled ? "Ativo" : "Pausado"}</span>
          {agent.draft_version_id ? <span class="status-pill orange">Alterações não publicadas</span> : null}
        </div>
      </div>
      {agent.description ? <p>{agent.description}</p> : null}
      <div class="tag-list">
        {agent.browser_enabled ? <span class="tag">Lê páginas no navegador</span> : null}
        {agent.can_create_jobs ? <span class="tag">Cria vagas</span> : null}
        {agent.can_edit_jobs ? <span class="tag">Completa dados de vagas</span> : null}
        {agent.memory_enabled ? <span class="tag">Usa memória</span> : null}
      </div>
      <p><strong>Fontes:</strong> {agent.source_ids.map(sourceName).join(", ") || "Nenhuma"}</p>
      <p><strong>Campos que pode alterar:</strong> {agent.editable_fields.map(fieldName).join(", ") || "Nenhum"}</p>
      <div class="card-footer">
        <span>Versão {agent.version}</span>
        <div class="button-row">
          {agent.draft_version_id ? (
            <button type="button" class="primary-button" data-publish-agent={agent.id} data-version-id={agent.draft_version_id}>Publicar</button>
          ) : null}
          <button type="button" class="secondary-button" data-agent-history={agent.id}>Versões</button>
          <button type="button" class="secondary-button" data-edit-agent={agent.id}>Editar</button>
        </div>
      </div>
    </article>
  );
}

export function AgentsPage({ title, roleLabel, sourceName, fieldName }: AgentsPageProps) {
  const agents = appData().agentConfigs;
  const active = agents.filter((agent) => agent.enabled).length;
  return (
    <>
      <PageHeading
        title={title}
        subtitle={`${active} de ${agents.length} agentes ativos. Cada agente só faz o que você liberar aqui.`}
        actions={<button type="button" class="primary-button" data-action="add-agent"><span aria-hidden="true">+</span> Novo agente</button>}
      />
      <div class="company-grid agent-grid">
        {agents.length
          ? agents.map((agent) => <AgentCard key={agent.id} agent={agent} roleLabel={roleLabel} sourceName={sourceName} fieldName={fieldName} />)
          : <EmptyState title="Nenhum agente configurado" detail="Crie um coletor ou um agente que complete dados de vagas." />}
      </div>
    </>
  );
}
