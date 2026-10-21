/** Equivalente JSX de `metric()` do app.ts (cartão de indicador do topo das páginas). */
export function MetricCard({ text, value, note, icon, tone = "teal", highlight = false }: {
  text: string; value: string | number; note: string; icon: string; tone?: string; highlight?: boolean;
}) {
  return (
    <article class={highlight ? "metric-card highlight" : "metric-card"}>
      <div class="metric-top"><span>{text}</span><span class={`metric-icon tone-${tone}`} aria-hidden="true">{icon}</span></div>
      <strong class="metric-value">{value}</strong>
      <div class="metric-note">{note}</div>
    </article>
  );
}
