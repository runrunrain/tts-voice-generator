import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { DesktopActionResult } from "./desktop-contracts";

type DesktopTrayServiceOptions = {
  getWindow: () => BrowserWindow | null;
  showWindow: () => BrowserWindow | null;
  requestQuit: () => Promise<DesktopActionResult>;
  sanitizeError: (error: unknown) => string;
};

export class DesktopTrayService {
  private tray: Tray | null = null;
  private disabledReason: string | null = null;

  constructor(private readonly options: DesktopTrayServiceOptions) {}

  initialize(): DesktopActionResult {
    if (this.tray) {
      return { ok: true };
    }

    try {
      const icon = nativeImage.createFromPath(this.resolveTrayIconPath());
      if (icon.isEmpty()) {
        this.disabledReason = "Tray icon resource is empty or unreadable.";
        return { ok: false, code: "tray-icon-unavailable", error: this.disabledReason };
      }
      if (process.platform === "darwin") {
        icon.setTemplateImage(true);
      }

      this.tray = new Tray(icon);
      this.tray.setToolTip("TTS Voice Generator");
      this.tray.on("click", () => {
        this.showWindow();
      });
      this.refreshMenu();
      return { ok: true };
    } catch (error) {
      this.disabledReason = this.options.sanitizeError(error);
      return { ok: false, code: "tray-initialization-failed", error: this.disabledReason };
    }
  }

  refreshMenu() {
    if (!this.tray) return;
    const window = this.options.getWindow();
    const visible = Boolean(window && !window.isDestroyed() && window.isVisible());
    const menu = Menu.buildFromTemplate([
      {
        label: "显示窗口",
        enabled: !visible,
        click: () => {
          this.showWindow();
        },
      },
      {
        label: "隐藏窗口",
        enabled: visible,
        click: () => {
          this.hideWindow();
        },
      },
      { type: "separator" },
      {
        label: "退出 TTS Voice Generator",
        click: () => {
          void this.options.requestQuit();
        },
      },
    ]);
    this.tray.setContextMenu(menu);
  }

  dispose() {
    this.tray?.destroy();
    this.tray = null;
  }

  getDisabledReason() {
    return this.disabledReason;
  }

  isAvailable() {
    return Boolean(this.tray);
  }

  private showWindow() {
    const window = this.options.showWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    this.refreshMenu();
  }

  private hideWindow() {
    const window = this.options.getWindow();
    if (window && !window.isDestroyed()) {
      window.hide();
    }
    this.refreshMenu();
  }

  private resolveTrayIconPath() {
    const fileName = process.platform === "darwin" ? "tray-iconTemplate.png" : "tray-icon.ico";
    const candidates = app.isPackaged
      ? [
          path.join(process.resourcesPath, "build", fileName),
          path.join(process.resourcesPath, fileName),
        ]
      : [
          path.join(process.cwd(), "build", fileName),
          path.join(app.getAppPath(), "build", fileName),
          path.join(__dirname, "..", "build", fileName),
        ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
  }
}
