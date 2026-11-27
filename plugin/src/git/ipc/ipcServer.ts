import { App } from "../../base/app";
import { Disposable, IDisposable } from "../../base/disposable";
import { LogOutputChannel } from "../logger";

const fs = acode.require('fs');
const Url = acode.require('Url');

export interface IIPCHandler {
  handle(request: any): Promise<any>;
}

export interface IIPCServer extends IDisposable {
  getEnv(): { [key: string]: string };
  registerHandler(name: string, handler: IIPCHandler): IDisposable;
}

class IPCServer implements IIPCServer {

  private handlers = new Map<string, IIPCHandler>();
  private ipcDir: string;
  private requestPipe: string;
  private readonly disposables: IDisposable[] = [];

  constructor(rootPath: string, private logger: LogOutputChannel) {
    this.ipcDir = Url.join(rootPath, 'ipc');
    this.requestPipe = Url.join(this.ipcDir, 'request.sock');

    App.onCloseApp(async () => await this.dispose(), null, this.disposables);
  }

  async start(): Promise<void> {
    // IPC over Alpine named pipes is disabled when using the Termux Git Bridge.
  }

  private async sendResponse(_pipePath: string, _data: string): Promise<void> {
    // Unused while IPC listener is disabled.
  }

  private async ensureDirectory(path: string): Promise<void> {
    const uri = `file://${path}`;
    const basename = Url.basename(uri);
    const dirname = Url.dirname(uri);

    const exists = await fs(uri).exists();
    if (!exists) {
      await fs(dirname).createDirectory(basename!);
    }
  }

  getEnv(): { [key: string]: string } {
    return {
      ACODE_GIT_IPC_DIR: this.ipcDir,
      ACODE_GIT_IPC_PIPE: this.requestPipe
    };
  }

  registerHandler(name: string, handler: IIPCHandler): IDisposable {
    const path = `/${name}`;
    this.handlers.set(path, handler);
    return Disposable.toDisposable(() => this.handlers.delete(path));
  }

  async dispose(): Promise<void> {
    this.disposables.forEach(d => d.dispose());
  }
}

export async function createIPCServer(root: string, logger: LogOutputChannel): Promise<IIPCServer> {
  const server = new IPCServer(root, logger);
  await server.start();
  return server;
}