/** Equivalente JSX do bloco `.empty-state` usado nas páginas legadas. */
export function EmptyState({ title, detail, compact = false }: { title: string; detail?: string; compact?: boolean }) {
  return (
    <div class={compact ? "empty-state compact" : "empty-state"}>
      <div>
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
    </div>
  );
}
