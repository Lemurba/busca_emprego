/**
 * Perfil confirmado mínimo para testes (#49, I49-09): a nota de aderência e as rodadas exigem
 * um snapshot de perfil confirmado. Cria o rascunho com um fato declarado e confirma pelo
 * núcleo (ator humano "tester"), devolvendo o perfil com o snapshot.
 */
export function confirmedProfile(store, facts = [{ type: "skills", value: ["SQL"], origin: "user", state: "confirmed" }], projectId = "busca-emprego") {
  const draft = store.createProfessionalProfile({ facts }, "tester", projectId);
  const profile = store.confirmProfessionalProfile(draft.id, "tester", projectId);
  if (!profile.snapshot?.id) throw new Error("perfil confirmado sem snapshot");
  return profile;
}
