import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import "./Wizard.css";
import { AppleID } from "./AppleID";
import { Device, DeviceInfo } from "./Device";
import { GlassCard } from "./components/GlassCard";

export const HELP_URL = "https://store.andresot.uk/help";
const ITUNES_URL = "https://apple.co/ms:iTunes";
const LOCALDEVVPN_HELP_URL = `${HELP_URL}#localdevvpn`;

type StepId = "prepare" | "connect" | "account" | "install" | "finish";
const STEPS: StepId[] = ["prepare", "connect", "account", "install", "finish"];

type Props = {
  loggedInAs: string | null;
  setLoggedInAs: (value: string | null) => void;
  noKeyringAvailable: boolean;
  selectedDevice: DeviceInfo | null;
  setSelectedDevice: (device: DeviceInfo | null) => void;
  registerRefresh: (fn?: () => void) => void;
  install: () => Promise<void>;
};

const open = (url: string) => openUrl(url).catch((e) => console.error(e));

export const Wizard = ({
  loggedInAs,
  setLoggedInAs,
  noKeyringAvailable,
  selectedDevice,
  setSelectedDevice,
  registerRefresh,
  install,
}: Props) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<StepId>("prepare");
  const [driverStatus, setDriverStatus] = useState<"checking" | "ok" | "missing">("checking");
  const [installing, setInstalling] = useState(false);
  const [installFailed, setInstallFailed] = useState(false);

  const index = STEPS.indexOf(step);

  const checkDriver = useCallback(async () => {
    setDriverStatus("checking");
    try {
      await invoke("list_devices");
      setDriverStatus("ok");
    } catch {
      setDriverStatus("missing");
    }
  }, []);

  useEffect(() => {
    checkDriver();
  }, [checkDriver]);

  const canContinue =
    (step === "prepare" && driverStatus === "ok") ||
    (step === "connect" && selectedDevice !== null) ||
    (step === "account" && loggedInAs !== null);

  const runInstall = async () => {
    setInstalling(true);
    setInstallFailed(false);
    try {
      await install();
      setStep("finish");
    } catch {
      setInstallFailed(true);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="wizard">
      <ol className="wizard-progress" aria-label={t("wizard.progress", { current: index + 1, total: STEPS.length })}>
        {STEPS.map((id, i) => (
          <li
            key={id}
            className={i < index ? "done" : i === index ? "current" : ""}
          >
            <span className="wizard-dot">{i < index ? "✓" : i + 1}</span>
            <span className="wizard-dot-label">{t(`wizard.${id}.short`)}</span>
          </li>
        ))}
      </ol>

      <GlassCard className="panel wizard-card">
        <p className="wizard-step-counter">
          {t("wizard.progress", { current: index + 1, total: STEPS.length })}
        </p>
        <h2 className="wizard-title">{t(`wizard.${step}.title`)}</h2>
        <p className="wizard-lead">{t(`wizard.${step}.lead`)}</p>

        {step === "prepare" && (
          <div className="wizard-body">
            {driverStatus === "checking" && (
              <div className="wizard-status">
                <div className="spinner small" /> {t("wizard.prepare.checking")}
              </div>
            )}
            {driverStatus === "ok" && (
              <div className="wizard-status ok">✓ {t("wizard.prepare.ok")}</div>
            )}
            {driverStatus === "missing" && (
              <>
                <div className="wizard-status warn">{t("wizard.prepare.missing")}</div>
                <ol className="wizard-list">
                  <li>{t("wizard.prepare.missing_step1")}</li>
                  <li>{t("wizard.prepare.missing_step2")}</li>
                  <li>{t("wizard.prepare.missing_step3")}</li>
                </ol>
                <div className="wizard-actions-inline">
                  <button className="primary-install" onClick={() => open(ITUNES_URL)}>
                    {t("wizard.prepare.download_itunes")}
                  </button>
                  <button onClick={checkDriver}>{t("wizard.check_again")}</button>
                </div>
              </>
            )}
          </div>
        )}

        {step === "connect" && (
          <div className="wizard-body">
            <ol className="wizard-list">
              <li>{t("wizard.connect.step1")}</li>
              <li>{t("wizard.connect.step2")}</li>
              <li>{t("wizard.connect.step3")}</li>
            </ol>
            <Device
              selectedDevice={selectedDevice}
              setSelectedDevice={setSelectedDevice}
              registerRefresh={registerRefresh}
            />
          </div>
        )}

        {step === "account" && (
          <div className="wizard-body">
            <ul className="wizard-notes">
              <li>{t("wizard.account.note_free")}</li>
              <li>{t("wizard.account.note_privacy")}</li>
              <li>{t("wizard.account.note_code")}</li>
            </ul>
            <AppleID
              loggedInAs={loggedInAs}
              setLoggedInAs={setLoggedInAs}
              noKeyringAvailable={noKeyringAvailable}
            />
          </div>
        )}

        {step === "install" && (
          <div className="wizard-body">
            <ul className="wizard-notes">
              <li>{t("wizard.install.note_device", { name: selectedDevice?.name ?? "iPhone" })}</li>
              <li>{t("wizard.install.note_cable")}</li>
            </ul>
            {installFailed && (
              <div className="wizard-status warn">{t("wizard.install.failed")}</div>
            )}
            <button
              className="primary-install wizard-big"
              disabled={installing}
              onClick={runInstall}
            >
              {installing ? t("wizard.install.installing") : t("app.install_anderstore")}
            </button>
          </div>
        )}

        {step === "finish" && (
          <div className="wizard-body">
            <div className="wizard-status ok">🎉 {t("wizard.finish.installed")}</div>
            <ol className="wizard-checklist">
              <li>
                <strong>{t("wizard.finish.devmode_title")}</strong>
                <span>{t("wizard.finish.devmode_path")}</span>
              </li>
              <li>
                <strong>{t("wizard.finish.trust_title")}</strong>
                <span>{t("wizard.finish.trust_path")}</span>
              </li>
              <li>
                <strong>{t("wizard.finish.vpn_title")}</strong>
                <span>{t("wizard.finish.vpn_path")}</span>
                <button className="link-button" onClick={() => open(LOCALDEVVPN_HELP_URL)}>
                  {t("wizard.finish.vpn_open")}
                </button>
              </li>
              <li>
                <strong>{t("wizard.finish.open_title")}</strong>
                <span>{t("wizard.finish.open_path")}</span>
              </li>
            </ol>
            <p className="wizard-hint">{t("wizard.finish.weekly")}</p>
          </div>
        )}

        <div className="wizard-footer">
          {index > 0 && step !== "finish" ? (
            <button disabled={installing} onClick={() => setStep(STEPS[index - 1])}>
              {t("wizard.back")}
            </button>
          ) : (
            <span />
          )}
          <button className="link-button" onClick={() => open(HELP_URL)}>
            {t("wizard.help")}
          </button>
          {step !== "install" && step !== "finish" && (
            <button
              className="primary-install"
              disabled={!canContinue}
              onClick={() => setStep(STEPS[index + 1])}
            >
              {t("wizard.next")}
            </button>
          )}
          {step === "finish" && (
            <button onClick={() => setStep("connect")}>{t("wizard.finish.again")}</button>
          )}
        </div>
        {!canContinue && step !== "install" && step !== "finish" && (
          <p className="wizard-hint right">{t(`wizard.${step}.waiting`)}</p>
        )}
      </GlassCard>
    </div>
  );
};
