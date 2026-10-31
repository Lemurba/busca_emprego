/** "1 vaga lida" / "3 vagas lidas": número com a forma certa, sem "(s)" no texto da interface (QAF-20). */
export function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}
