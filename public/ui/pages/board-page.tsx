/**
 * Página "Quadro" (kanban) em Preact (antes `renderBoard()` + `bindDragEvents()` em app.ts).
 *
 * Mesmas classes, textos e atributos `data-*` da versão em string: o clique no cartão e no
 * título continua delegado no #view (`data-detail-id`/`data-detail`) e "Nova vaga" usa
 * `data-action`. Arrastar e soltar e o "Mover para…" agora são handlers do próprio
 * componente (antes eram listeners presos depois de cada `render()`, que num diff do Preact
 * se acumulariam nos mesmos elementos). As dicas de destino (`drop-valid`/`drop-invalid`/
 * `drag-over`) vêm do estado local do arraste.
 */
import { useRef, useState } from "preact/hooks";
import type { Data } from "../../app.js";
import { appData } from "../app-state.js";
import { PageHeading } from "../components/page-heading.js";

type Job = Data["jobs"][number];
type Lifecycle = Job["lifecycle"];
type StatusColumn = { title: string; statuses: string[]; target: string | null };

/** Vocabulário e ações que continuam em app.ts. */
export type BoardPageProps = {
  title: string;
  statusColumns: StatusColumn[];
  statusLabels: Record<string, string>;
  lifecycleMeta: Record<Lifecycle, { label: string; tone: string }>;
  /** Próximas etapas válidas da vaga (kanbanMoves). */
  allowedMoves: (job: Job) => string[];
  salaryLabel: (job: Job) => string;
  deadlineText: (job: Job) => string;
  repostText: (job: Job) => string;
  /** Move a vaga pela transição do workflow; mostra o erro em toast e devolve false se falhar. */
  onMove: (jobId: string, status: string) => Promise<boolean>;
};

type CardProps = Omit<BoardPageProps, "title" | "statusColumns"> & {
  job: Job;
  onDragStart: (job: Job, event: DragEvent) => void;
  onDragEnd: () => void;
};

/** Mesmas faixas do domínio (calculateScore): ≥ 80 match forte, ≥ 65 vale olhar. */
function ScoreBadge({ score }: { score: number }) {
  const tone = score >= 80 ? "high" : score >= 65 ? "mid" : "low";
  return <span class={`score ${tone}`} title="Aderência: estimativa de quanto a vaga combina com seu perfil (não é nota de ATS)">{score}%</span>;
}

function columnTitle(columns: StatusColumn[], statusLabels: Record<string, string>, status: string) {
  return columns.find((column) => column.target === status)?.title ?? statusLabels[status] ?? status;
}

function JobCard({ job, columns, statusLabels, lifecycleMeta, allowedMoves, salaryLabel, deadlineText, repostText, onMove, onDragStart, onDragEnd }: CardProps & { columns: StatusColumn[] }) {
  const [busy, setBusy] = useState(false);
  const moves = allowedMoves(job);
  const draggable = moves.length > 0;
  const meta = lifecycleMeta[job.lifecycle] ?? lifecycleMeta.unknown;
  const repost = repostText(job);
  const move = async (event: Event) => {
    const select = event.currentTarget as HTMLSelectElement;
    const status = select.value;
    if (!status) return;
    setBusy(true);
    await onMove(job.id, status);
    // Volta para "Mover para…": se a vaga ficou na mesma coluna, as opções mudaram de etapa.
    select.value = "";
    setBusy(false);
  };
  return (
    <article
      class={`job-card ${draggable ? "is-draggable" : ""}`}
      draggable={draggable ? true : undefined}
      data-drag-id={draggable ? job.id : undefined}
      data-detail-id={job.id}
      onDragStart={draggable ? (event) => onDragStart(job, event) : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
    >
      <div class="job-card-top">
        <h3><button type="button" class="card-title-button" data-detail={job.id}>{job.title}</button></h3>
        <ScoreBadge score={job.match_score} />
      </div>
      <p><strong>{job.company}</strong> · {job.location}</p>
      <div class="job-card-meta">
        <span class={`status-pill ${meta.tone}`}>{meta.label}</span>
        <span class="chip">{job.work_model}</span>
        <span class="chip">{job.source}</span>
        {job.insecure_url ? <span class="chip" title="O link da vaga usa http:// (sem criptografia)">Link não seguro</span> : null}
        {repost ? <span class="chip orange" title="Mesma empresa, título e descrição de vaga anterior">{repost}</span> : null}
      </div>
      <div class="card-footer"><span>{salaryLabel(job)}</span><span>{deadlineText(job)}</span></div>
      {moves.length ? (
        <label class="move-field">
          <span class="visually-hidden">Mover {job.title} para outra etapa</span>
          <select class="move-select" data-move-id={job.id} disabled={busy} onChange={move}>
            <option value="">Mover para…</option>
            {moves.map((status) => <option key={status} value={status}>{columnTitle(columns, statusLabels, status)}</option>)}
          </select>
        </label>
      ) : null}
    </article>
  );
}

export function BoardPage({ title, statusColumns, ...cardProps }: BoardPageProps) {
  const data = appData();
  const { allowedMoves, onMove } = cardProps;
  // Vaga sendo arrastada (estado para as dicas visuais; ref para o drop ler sem esperar o re-render).
  const [dragging, setDragging] = useState<{ jobId: string; allowed: string[] } | null>(null);
  const [overStatus, setOverStatus] = useState<string | null>(null);
  const draggingRef = useRef<{ jobId: string; allowed: string[] } | null>(null);

  const startDrag = (job: Job, event: DragEvent) => {
    const current = { jobId: job.id, allowed: allowedMoves(job) };
    draggingRef.current = current;
    event.dataTransfer?.setData("text/plain", job.id);
    setDragging(current);
  };
  const endDrag = () => {
    draggingRef.current = null;
    setDragging(null);
    setOverStatus(null);
  };
  const drop = async (target: string, event: DragEvent) => {
    event.preventDefault();
    const current = draggingRef.current;
    const jobId = event.dataTransfer?.getData("text/plain") || current?.jobId;
    const valid = Boolean(current?.allowed.includes(target));
    endDrag();
    if (!jobId || !valid) return;
    await onMove(jobId, target);
  };

  return (
    <>
      <PageHeading
        title={title}
        subtitle="Arraste ou use “Mover para…” nas etapas iniciais. Interesse, currículo e candidatura avançam pelo detalhe da vaga."
        actions={<button type="button" class="primary-button" data-action="add-job"><span aria-hidden="true">+</span> Nova vaga</button>}
      />
      <div class="board">
        {statusColumns.map((column) => {
          const jobs = data.jobs.filter((job) => column.statuses.includes(job.status));
          const target = column.target;
          const headingId = `column-${column.statuses[0]}`;
          const valid = Boolean(dragging && target && dragging.allowed.includes(target));
          const hint = dragging ? (valid ? "drop-valid" : "drop-invalid") : "";
          const over = valid && overStatus === target ? "drag-over" : "";
          return (
            <section key={headingId} class="board-column" aria-labelledby={headingId}>
              <div class="column-head">
                <h2 class="column-title" id={headingId}>{column.title}</h2>
                {/* Contagem com texto para leitores de tela (aria-label num <span> sem papel é ignorado). */}
                <span class="column-count">{jobs.length}<span class="visually-hidden"> vagas</span></span>
              </div>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: arrastar é atalho de mouse; pelo teclado o mesmo movimento é o "Mover para…" de cada cartão. */}
              <div
                class={["column-drop", hint, over].filter(Boolean).join(" ")}
                data-drop-status={target ?? undefined}
                onDragOver={target ? (event) => { if (!draggingRef.current?.allowed.includes(target)) return; event.preventDefault(); setOverStatus(target); } : undefined}
                onDragLeave={target ? () => setOverStatus((current) => (current === target ? null : current)) : undefined}
                onDrop={target ? (event) => void drop(target, event) : undefined}
              >
                {jobs.length
                  ? jobs.map((job) => <JobCard key={job.id} job={job} columns={statusColumns} {...cardProps} onDragStart={startDrag} onDragEnd={endDrag} />)
                  : <p class="column-empty">{target ? "Nenhuma vaga nesta etapa" : "Avança pelo detalhe da vaga"}</p>}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
