import { useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { Modal } from "./Modal";
import type { Certificate } from "../pages/Certificates";
import "../AppleID.css";

// Certificate creation occurs during installation, after the account step has
// unmounted. Keep this listener at app level for the entire operation.
export const CertificatePrompt = () => {
  const { t } = useTranslation();
  const [certificates, setCertificates] = useState<Certificate[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [responding, setResponding] = useState(false);
  const [responseFailed, setResponseFailed] = useState(false);
  const respondingRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<Certificate[]>("max-certs-reached", ({ payload }) => {
      if (disposed) return;
      setSelected(null);
      setResponseFailed(false);
      setCertificates(payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const respond = async (serial: string | null) => {
    if (respondingRef.current) return;
    respondingRef.current = true;
    setResponding(true);
    setResponseFailed(false);
    try {
      await emit("max-certs-response", serial ? [serial] : null);
      setCertificates(null);
      setSelected(null);
    } catch {
      setResponseFailed(true);
    } finally {
      respondingRef.current = false;
      setResponding(false);
    }
  };

  return <Modal sizeFit isOpen={certificates !== null} zIndex={2000}>
    <h2 className="cert-header">{t("apple_id.max_certs_title")}</h2>
    <p>{t("apple_id.max_certs_desc")}</p>
    <p className="credentials-warning">{t("apple_id.cert_revoke_warning")}</p>
    {responseFailed && <p role="alert">{t("apple_id.cert_response_failed")}</p>}
    {certificates?.length === 0 && <p>{t("apple_id.cert_none_available")}</p>}
    <fieldset disabled={responding} className="operation-fieldset">
      <legend>{t("apple_id.choose_what_to_revoke")}</legend>
      <div className="certs-list">
        {certificates?.map((cert) => <label className="cert-item" key={cert.serialNumber}>
          <input type="radio" name="certificate-to-revoke" value={cert.serialNumber}
            checked={selected === cert.serialNumber} onChange={() => setSelected(cert.serialNumber)} />
          <span>{cert.name} · {cert.machineName || t("apple_id.cert_unknown_machine")}<br />{cert.serialNumber}</span>
        </label>)}
      </div>
      <div className="certs-buttons">
        <button className="action-button danger" disabled={!selected} onClick={() => void respond(selected)}>
          {t("apple_id.cert_revoke_selected")}
        </button>
        <button onClick={() => void respond(null)}>{t("common.cancel")}</button>
      </div>
    </fieldset>
  </Modal>;
};
