import type { BrowserWindow } from "electron";
import type { MainToRendererMessage } from "@contracts/ipc";

let mainWindow: BrowserWindow | null = null;
export const getMainWindow = () => mainWindow;
export const setTestWindow = (window: BrowserWindow) => { mainWindow = window; };
export const sendToRenderer = (_channel: string, _message: MainToRendererMessage) => {};
export const updateTitleBarOverlay = () => {};
