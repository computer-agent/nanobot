import { contextBridge, ipcRenderer } from "electron";

type DesktopRuntimeInfo = {
  surface: "desktop";
  app_version: string;
  engine_status: "starting" | "ready" | "restarting" | "stopped" | "crashed";
  data_dir: string;
  logs_dir: string;
  config_path: string;
  workspace_path: string;
  python: string;
  api_base?: string;
};

contextBridge.exposeInMainWorld("nanobotDesktop", {
  getRuntimeInfo: (): Promise<DesktopRuntimeInfo> =>
    ipcRenderer.invoke("nanobot:get-runtime-info"),
  restartEngine: (): Promise<void> => ipcRenderer.invoke("nanobot:restart-engine"),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("nanobot:pick-folder"),
  openLogs: (): Promise<void> => ipcRenderer.invoke("nanobot:open-logs"),
  exportDiagnostics: (): Promise<string> =>
    ipcRenderer.invoke("nanobot:export-diagnostics"),
  checkForUpdates: (): Promise<{ supported: boolean; message?: string }> =>
    ipcRenderer.invoke("nanobot:check-for-updates"),
});
