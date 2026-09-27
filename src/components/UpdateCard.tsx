import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useActivity } from "../activity";
import { updates } from "../update";

export function UpdateCard() {
  const { t } = useTranslation();
  const state = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const busy = useActivity();
  if (!state.visible) return null;
  const running = state.phase === "downloading" || state.phase === "installing";
  const bytes = (value: number) => `${(value / 1048576).toFixed(1)} ${t("update.mb")}`;
  const percent = state.total ? Math.min(100, Math.floor(state.downloaded / state.total * 100)) : undefined;
  return <section className="update-card" aria-label={t("update.title")}>
    <div aria-live="polite">
      <h2>{t(`update.phase_${state.phase}`)}</h2>
      {state.version && <p>{t("update.versions", { current: state.currentVersion, next: state.version })}</p>}
      {state.phase === "downloading" && <>
        <progress aria-label={t("update.phase_downloading")} max={100} value={percent} />
        <p>{percent === undefined ? bytes(state.downloaded) : `${bytes(state.downloaded)} / ${bytes(state.total!)} · ${percent}%`}</p>
      </>}
      {state.phase === "installing" && <p>{t("update.restart_hint")}</p>}
      {state.phase === "error" && <details><summary>{t("common.more_details")}</summary><pre>{state.error}</pre></details>}
    </div>
    {busy && busy !== "update" && (state.phase === "available" || state.phase === "error") && <p>{t("update.busy")}</p>}
    <div className="wizard-actions-inline">
      {state.phase === "available" && <button className="primary-install" disabled={!!busy} onClick={() => void updates.install()}>{t("update.install")}</button>}
      {state.phase === "error" && <button disabled={!!busy} onClick={() => void updates.check(true)}>{t("update.retry")}</button>}
      {!running && <button onClick={updates.dismiss}>{t(state.phase === "available" ? "update.later" : "update.close")}</button>}
    </div>
  </section>;
}
