import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { InstallationReceipt } from "../installationReceipt";

export function InstallationGuide({ receipt, openPairing, canPair }: {
  receipt: InstallationReceipt;
  openPairing: () => void;
  canPair: boolean;
}) {
  const { t, i18n } = useTranslation();
  const developerMode = Number.parseInt(receipt.iosVersion, 10) >= 16;
  const instructions = [
    t("wizard.finish.trust_path", { email: receipt.appleId }),
    ...(developerMode ? [t("wizard.finish.devmode_path")] : []),
    t("wizard.finish.vpn_path"),
    t("guide.wifi"),
    t("guide.login", { email: receipt.appleId }),
    t("guide.refresh"),
  ];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([
        `AnderStore — ${receipt.deviceName}`,
        t("guide.account", { email: receipt.appleId }),
        ...instructions.map((text, i) => `${i + 1}. ${text}`),
        t("wizard.finish.weekly"),
        t("guide.version_note"),
      ].join("\n\n"));
      toast.success(t("guide.copied"));
    } catch { toast.error(t("guide.copy_failed")); }
  };
  return <div className="installation-guide">
    <div className="signing-account">
      <strong>{t("guide.account_label")}</strong>
      <span>{receipt.appleId}</span>
      <p>{t("guide.icloud")}</p>
    </div>
    <p className="wizard-hint">{receipt.deviceName} · {new Date(receipt.installedAt).toLocaleDateString(i18n.language)}</p>
    <ol className="wizard-checklist">{instructions.map((text) => <li key={text}>{text}</li>)}</ol>
    <p>{t("wizard.finish.weekly")}</p>
    <p className="wizard-hint">{t("guide.version_note")}</p>
    <button onClick={() => void copy()}>{t("guide.copy")}</button>
    <details className="guide-help">
      <summary>{t("guide.vpn_problem")}</summary>
      <p>{t("guide.vpn_uncertain")}</p>
      <ol className="wizard-list">
        <li>{t("guide.check_account", { email: receipt.appleId })}</li>
        <li>{t("guide.check_vpn")}</li>
        <li>{t("guide.check_pairing")}</li>
      </ol>
      <button disabled={!canPair} onClick={openPairing}>{t("guide.repair")}</button>
      {!canPair && <p className="wizard-hint">{t("guide.repair_connect", { device: receipt.deviceName })}</p>}
    </details>
  </div>;
}
