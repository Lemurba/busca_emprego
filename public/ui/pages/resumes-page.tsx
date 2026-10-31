/**
 * Página "Currículos" em Preact (antes era `renderResumes()` em app.ts).
 *
 * Mantém as mesmas classes, textos e atributos `data-*`: os formulários de envio do PDF-base
 * e de importação do JSON Resume (`data-form`) continuam tratados pelo `submit` delegado no
 * #view (`handleForm`), e Usar como base/Excluir/Editar (`data-action`, `data-edit-resume`)
 * pela delegação de cliques (`handleAction`). O editor/aprovação segue no modal legado.
 * #49: "Criar perfil a partir deste PDF" (`create-profile-from-base`) abre a revisão do rascunho.
 * Os campos dos formulários não são controlados: depois de um envio, `handleForm` limpa o
 * formulário (`form.reset()`), já que o diff do Preact preserva os mesmos elementos.
 */
import type { BaseResume, Job, ParseCheckSummary, Resume } from "../../app.js";
import { appData } from "../app-state.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeading } from "../components/page-heading.js";

export type ResumesPageProps = { title: string };

function ParseCheckPill({ check }: { check: ParseCheckSummary | null | undefined }) {
  if (!check || check.stale) return <span class="status-pill neutral">Leitura do PDF não testada</span>;
  return check.ok ? <span class="status-pill teal">Leitura do PDF ok</span> : <span class="status-pill red">Leitura do PDF falhou</span>;
}

/** Downloads gerados pelo servidor (#35); mesmos links de `resumeDownloadLinks()` do editor legado. */
function ResumeDownloadLinks({ resume }: { resume: Resume }) {
  const base = `api/resumes/${encodeURIComponent(resume.id)}/files`;
  return (
    <div class="button-row resume-download-row">
      <a class="secondary-button" href={`${base}/pdf`}>Baixar PDF</a>
      <a class="secondary-button" href={`${base}/docx`}>Baixar DOCX</a>
      <a class="secondary-button" href={`${base}/json`} title="Formato padrão aberto (jsonresume.org)">JSON Resume</a>
    </div>
  );
}

function BaseResumeCard({ resume, draftVersion }: { resume: BaseResume; draftVersion: number | null }) {
  // Sem texto extraído o rascunho nasceria vazio (mesma regra de BASE_RESUME_EXTRACTION_REQUIRED).
  const extracted = resume.extraction_status === undefined || resume.extraction_status === "extracted";
  const hintId = `base-resume-hint-${resume.id}`;
  return (
    <article class="resume-card">
      <div class="resume-top">
        <div><h3>{resume.title}</h3><p>{resume.file_name}</p></div>
        <span class={`status-pill ${resume.is_base ? "teal" : "neutral"}`}>{resume.is_base ? "Em uso" : "Na biblioteca"}</span>
      </div>
      {!extracted ? <p id={hintId} class="muted-text">Não foi possível ler o texto deste PDF (digitalizado como imagem?). Envie um PDF com texto selecionável ou importe um JSON Resume.</p> : null}
      {extracted && draftVersion != null ? <p id={hintId} class="muted-text">{`Já existe o rascunho de perfil v${draftVersion}: revise-o ou descarte-o em Saúde das buscas antes de criar outro.`}</p> : null}
      <div class="button-row">
        <button type="button" class="primary-button" data-action="create-profile-from-base" data-resume-id={resume.id} disabled={!extracted || draftVersion != null} aria-describedby={!extracted || draftVersion != null ? hintId : undefined}>Criar perfil a partir deste PDF</button>
        <a class="secondary-button" href={`api/base-resumes/${encodeURIComponent(resume.id)}/file`}>Baixar PDF</a>
        {!resume.is_base ? <button type="button" class="secondary-button" data-action="select-base-resume" data-resume-id={resume.id}>Usar como base</button> : null}
        <button type="button" class="danger-button" data-action="delete-base-resume" data-resume-id={resume.id} data-resume-title={resume.title}>Excluir</button>
      </div>
    </article>
  );
}

function resumeHint(resume: Resume) {
  if (resume.status === "approved") return "Pronto para a etapa de candidatura.";
  const pending = resume.fact_check?.pending;
  // Checagem de fatos (#31): fatos novos precisam de decisão antes do APROVO.
  if (pending) return `${pending} fato${pending === 1 ? "" : "s"} novo${pending === 1 ? "" : "s"} para confirmar, corrigir ou remover antes de aprovar.`;
  return "Revise os destaques antes de aprovar.";
}

function ResumeCard({ resume, job }: { resume: Resume; job: Job | undefined }) {
  const approved = resume.status === "approved";
  const status = approved ? "Aprovado" : resume.status === "review" ? "Em revisão" : "Rascunho";
  const missing = resume.coverage?.missing_keywords ?? [];
  return (
    <article class="resume-card">
      <div class="resume-top">
        <div><h3>{resume.title}</h3><p>{job?.company ?? "Vaga removida"} · versão {resume.version}</p></div>
        <span class={`status-pill ${approved ? "teal" : "orange"}`}>{status}</span>
      </div>
      <p>{resumeHint(resume)}</p>
      <div class="tag-list">{resume.keywords.slice(0, 6).map((keyword) => <span class="tag">{keyword}</span>)}</div>
      <p>
        <strong>Cobertura de requisitos: {resume.coverage ? `${resume.coverage.total}%` : "—"}</strong>
        {missing.length ? <><br /><small>Faltam: {missing.slice(0, 6).join(", ")}{missing.length > 6 ? "…" : ""}</small></> : null}
      </p>
      <div class="job-card-meta"><ParseCheckPill check={resume.parse_check} /></div>
      <ResumeDownloadLinks resume={resume} />
      <div class="resume-foot">
        <span>{resume.changes.length} sugest{resume.changes.length === 1 ? "ão" : "ões"} de ajuste</span>
        <button type="button" class="text-button" data-edit-resume={resume.id}>Editar →</button>
      </div>
    </article>
  );
}

export function ResumesPage({ title }: ResumesPageProps) {
  const data = appData();
  const jobs = new Map(data.jobs.map((job) => [job.id, job]));
  const draftVersion = data.draftProfiles?.[0]?.version ?? null;
  return (
    <>
      <PageHeading title={title} subtitle="Revise o currículo adaptado a cada vaga e aprove antes de qualquer envio. A aprovação não envia nada sozinha." />
      <section class="panel">
        <div class="section-head flush"><div><h2>Currículos-base</h2><p>Envie PDFs, escolha qual será usado nas próximas adaptações e baixe uma cópia.</p></div></div>
        <form data-form="base-resume" class="base-resume-form">
          <div class="form-field"><label for="base-resume-title">Nome</label><input class="input" id="base-resume-title" name="title" required placeholder="Currículo principal" /></div>
          <div class="form-field"><label for="base-resume-file">Arquivo PDF (máx. 5 MB)</label><input class="input" id="base-resume-file" name="file" type="file" accept="application/pdf,.pdf" required /></div>
          <button class="primary-button" type="submit">Enviar PDF</button>
        </form>
        <form data-form="json-resume-import" class="base-resume-form">
          {/* Mesmo "um rascunho por vez" do PDF-base: o servidor recusa com profile.draft_exists. */}
          <div class="form-field"><span>Já tem um currículo em JSON Resume?</span><small>{draftVersion != null ? `Já existe o rascunho de perfil v${draftVersion}: revise-o ou descarte-o em Saúde das buscas antes de importar.` : "Vira um novo perfil em rascunho; revise e confirme as informações antes de usar."}</small></div>
          <div class="form-field"><label for="json-resume-file">Arquivo JSON Resume (máx. 1 MB)</label><input class="input" id="json-resume-file" name="file" type="file" accept="application/json,.json" required /></div>
          <button class="secondary-button" type="submit">Importar JSON Resume</button>
        </form>
        <div class="resume-grid">
          {data.baseResumes.length
            ? data.baseResumes.map((resume) => <BaseResumeCard key={resume.id} resume={resume} draftVersion={draftVersion} />)
            : <EmptyState title="Nenhum currículo-base" detail="Envie um PDF para começar a adaptar por vaga." />}
        </div>
      </section>
      <div class="section-head"><div><h2>Currículos por vaga</h2><p>Cada um nasce quando você marca interesse numa vaga.</p></div></div>
      <div class="resume-grid">
        {data.resumes.length
          ? data.resumes.map((resume) => <ResumeCard key={resume.id} resume={resume} job={jobs.get(resume.job_id)} />)
          : <EmptyState title="Sem currículos ainda" detail="Abra uma vaga e marque “Tenho interesse” para criar o primeiro." />}
      </div>
    </>
  );
}
