import type { ComponentChildren } from "preact";

/** Equivalente JSX de `pageHeading()` do app.ts (mesmas classes e o mesmo #page-heading focável). */
export function PageHeading({ title, subtitle, actions }: { title: string; subtitle: string; actions?: ComponentChildren }) {
  return (
    <div class="page-heading">
      <div>
        <h1 id="page-heading" tabIndex={-1}>{title}</h1>
        <p class="subtitle">{subtitle}</p>
      </div>
      {actions ? <div class="button-row">{actions}</div> : null}
    </div>
  );
}
