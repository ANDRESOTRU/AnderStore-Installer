import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { DeviceInfo } from "./Device";
import { HELP_URL, Wizard } from "./Wizard";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  installAnderStoreOperation,
  Operation,
  OperationState,
  OperationUpdate,
} from "./components/operations";
import { listen } from "@tauri-apps/api/event";
import OperationView from "./components/OperationView";
import { toast } from "sonner";
import { Modal } from "./components/Modal";
import { Certificates } from "./pages/Certificates";
import { AppIds } from "./pages/AppIds";
import { Settings } from "./pages/Settings";
import { Pairing } from "./pages/Pairing";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdates } from "./update";
import logo from "./anderstore.png";
import { GlassCard } from "./components/GlassCard";
import { useTranslation } from "react-i18next";
import { usePlatform } from "./PlatformContext";

function App() {
  const { t } = useTranslation();

  const [operationState, setOperationState] = useState<OperationState | null>(
    null,
  );
  const [loggedInAs, setLoggedInAs] = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  const [openModal, setOpenModal] = useState<
    null | "certificates" | "appids" | "pairing"
  >(null);
  const [version, setVersion] = useState<string>("");

  const refreshDevicesRef = useRef<(() => void) | null>(null);

  const [noKeyringAvailable, setNoKeyringAvailable] = useState<boolean>(false);
  const { platform } = usePlatform();

  const checkKeyring = useCallback(async () => {
    try {
      let available = await invoke<boolean>("keyring_available");
      setNoKeyringAvailable(!available);
    } catch (e) {
      console.error("Unable to check keyring availability:", e);
      setNoKeyringAvailable(true);
    }
  }, []);

  useEffect(() => {
    checkKeyring();
  }, [checkKeyring]);

  useEffect(() => {
    const fetchVersion = async () => {
      const version = await getVersion();
      setVersion(version);
    };
    fetchVersion();
  }, []);

  useEffect(() => {
    void checkForUpdates(true);
  }, []);

  const shortcutLabel = useCallback(
    (mac: string, windows: string, linux?: string) => {
      if (platform === "mac") return mac;
      if (platform === "linux") return linux ?? windows;
      return windows;
    },
    [platform],
  );

  const startOperation = useCallback(
    async (
      operation: Operation,
      params: { [key: string]: any },
    ): Promise<void> => {
      setOperationState({
        current: operation,
        started: [],
        failed: [],
        completed: [],
      });
      return new Promise<void>(async (resolve, reject) => {
        const unlistenFn = await listen<OperationUpdate>(
          "operation_" + operation.id,
          (event) => {
            setOperationState((old) => {
              if (old == null) return null;
              if (event.payload.updateType === "started") {
                return {
                  ...old,
                  started: [...old.started, event.payload.stepId],
                };
              } else if (event.payload.updateType === "finished") {
                return {
                  ...old,
                  completed: [...old.completed, event.payload.stepId],
                };
              } else if (event.payload.updateType === "failed") {
                return {
                  ...old,
                  failed: [
                    ...old.failed,
                    {
                      stepId: event.payload.stepId,
                      extraDetails: event.payload.extraDetails,
                    },
                  ],
                };
              }
              return old;
            });
          },
        );
        try {
          await invoke(operation.id + "_operation", params);
          unlistenFn();
          resolve();
        } catch (e) {
          unlistenFn();
          reject(e);
        }
      });
    },
    [setOperationState],
  );

  const ensuredLoggedIn = useCallback((): boolean => {
    if (loggedInAs) return true;
    toast.error(t("app.must_be_logged_in"));
    return false;
  }, [loggedInAs, t]);

  const ensureSelectedDevice = useCallback((): boolean => {
    if (selectedDevice) return true;
    toast.error(t("app.must_select_device"));
    return false;
  }, [selectedDevice, t]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === undefined) return;
      const key = event.key.toLowerCase();
      const primaryPressed = platform === "mac" ? event.metaKey : event.ctrlKey;
      if (!primaryPressed) return;

      if (!event.shiftKey && key === "p") {
        event.preventDefault();
        if (!ensureSelectedDevice()) return;
        setOpenModal("pairing");
      } else if (event.shiftKey && key === "c") {
        event.preventDefault();
        if (!ensuredLoggedIn()) return;
        setOpenModal("certificates");
      } else if (event.shiftKey && key === "a") {
        event.preventDefault();
        if (!ensuredLoggedIn()) return;
        setOpenModal("appids");
      } else if (!event.shiftKey && key === "r") {
        event.preventDefault();
        refreshDevicesRef.current?.();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [platform, ensureSelectedDevice, ensuredLoggedIn]);

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div className="header-left">
          <div className="title-block">
            <img src={logo} alt={t("app.logo_alt")} className="logo" />
            <div>
              <h1 className="title">AnderStore Installer</h1>
              <p className="subtitle">{t("subtitle")}</p>
            </div>
          </div>
          <span className="version-pill">
            {t("version")} {version}
          </span>
        </div>
        <div className="header-actions">
          <button
            className="toolbar-button"
            onClick={() => void checkForUpdates(false)}
          >
            {t("update.check")}
          </button>
          <button
            className="toolbar-button"
            onClick={async () => {
              try {
                await openUrl(HELP_URL);
              } catch (error) {
                console.error("Failed to open GitHub link", error);
                toast.error(t("app.open_github_failed"));
              }
            }}
          >
            {t("wizard.help")}
          </button>
        </div>
      </header>
      <div className="workspace-body wizard-layout">
        <Wizard
          loggedInAs={loggedInAs}
          setLoggedInAs={setLoggedInAs}
          noKeyringAvailable={noKeyringAvailable}
          selectedDevice={selectedDevice}
          setSelectedDevice={setSelectedDevice}
          registerRefresh={(fn) => {
            refreshDevicesRef.current = fn ?? null;
          }}
          install={() =>
            startOperation(installAnderStoreOperation, {
              nightly: false,
              liveContainer: true,
            })
          }
        />
        <details className="advanced">
          <summary>{t("wizard.advanced")}</summary>
          <div className="advanced-content">
            <div className="workspace-list">
              <button
                className="workspace-list-item"
                onClick={() => {
                  if (!ensureSelectedDevice()) return;
                  setOpenModal("pairing");
                }}
              >
                {t("app.manage_pairing_file")}{" "}
                <span aria-hidden="true">{shortcutLabel("⌘P", "Ctrl+P")}</span>
              </button>
              <button
                className="workspace-list-item"
                onClick={() => {
                  if (!ensuredLoggedIn()) return;
                  setOpenModal("certificates");
                }}
              >
                {t("app.certificates")}{" "}
                <span aria-hidden="true">
                  {shortcutLabel("⌘⇧C", "Ctrl+Shift+C")}
                </span>
              </button>
              <button
                className="workspace-list-item"
                onClick={() => {
                  if (!ensuredLoggedIn()) return;
                  setOpenModal("appids");
                }}
              >
                {t("app.app_ids")}{" "}
                <span aria-hidden="true">
                  {shortcutLabel("⌘⇧A", "Ctrl+Shift+A")}
                </span>
              </button>
            </div>
            <GlassCard className="panel about-panel">
              <h3 style={{ marginTop: 0 }}>{t("about.title")}</h3>
              <p className="muted-text">
                AnderStore Installer · ANDRESOT · {t("version")} {version}
              </p>
              <div className="workspace-list">
                <button className="workspace-list-item" onClick={() => openUrl("https://andresot.ru")}>
                  andresot.ru
                </button>
                <button
                  className="workspace-list-item"
                  onClick={() => openUrl("https://github.com/ANDRESOTRU/AnderStore-Installer")}
                >
                  {t("about.source")}
                </button>
                <button className="workspace-list-item" onClick={() => openUrl("https://github.com/nab138/iloader")}>
                  {t("about.licenses")}
                </button>
              </div>
              <p className="muted-text">{t("about.licensesDesc")}</p>
            </GlassCard>
            <GlassCard className="panel settings-panel">
              <Settings
                ensureSelectedDevice={ensureSelectedDevice}
                setSelectedDevice={setSelectedDevice}
                platform={platform}
                shortcutLabel={shortcutLabel}
                checkKeyring={checkKeyring}
              />
            </GlassCard>
          </div>
        </details>
        {operationState && (
          <OperationView
            operationState={operationState}
            closeMenu={() => setOperationState(null)}
          />
        )}
      </div>
      <Modal
        isOpen={openModal === "certificates"}
        close={() => setOpenModal(null)}
      >
        <Certificates />
      </Modal>
      <Modal isOpen={openModal === "appids"} close={() => setOpenModal(null)}>
        <AppIds />
      </Modal>
      <Modal isOpen={openModal === "pairing"} close={() => setOpenModal(null)}>
        <Pairing />
      </Modal>
    </main>
  );
}

export default App;
