import type { BrowserWindow } from "electron";
import type { MainToRendererMessage } from "@contracts/ipc";

let mainWindow: BrowserWindow | null = null;
/** Every push main sent to the renderer, so the smoke can assert on events. */
export const sentMessages: MainToRendererMessage[] = [];
export const getMainWindow = () => mainWindow;
export const setTestWindow = (window: BrowserWindow) => { mainWindow = window; };
export const sendToRenderer = (_channel: string, message: MainToRendererMessage) => { sentMessages.push(message); };
export const updateTitleBarOverlay = () => {};
