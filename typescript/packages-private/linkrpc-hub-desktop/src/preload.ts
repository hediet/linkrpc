import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { type CallRecord, type DesktopState, type HubDesktopBridge, IPC_CALLS, IPC_INVOKE, IPC_STATE } from './protocol';

const bridge: HubDesktopBridge = {
    invoke: (action, ...params) => ipcRenderer.invoke(IPC_INVOKE, action, params[0]),
    onState: listener => {
        const handler = (_event: IpcRendererEvent, state: DesktopState) => listener(state);
        ipcRenderer.on(IPC_STATE, handler);
        return () => ipcRenderer.off(IPC_STATE, handler);
    },
    onCall: listener => {
        const handler = (_event: IpcRendererEvent, call: CallRecord) => listener(call);
        ipcRenderer.on(IPC_CALLS, handler);
        return () => ipcRenderer.off(IPC_CALLS, handler);
    },
};

contextBridge.exposeInMainWorld('hubDesktop', bridge);
