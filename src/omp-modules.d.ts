/**
 * The OMP-only modules below exist in the host runtime (resolved by the
 * host's extension loader hook) but are not dependencies of this repo, so
 * they are declared ambiently to keep `tsc` clean. Every dynamic import of
 * these specifiers MUST stay inside try/catch: the specifier is literal (the
 * host only rewrites literal specifiers) and the import rejects on any host
 * where the module does not exist.
 */
declare module '@oh-my-pi/pi-coding-agent/registry/agent-registry';

/**
 * The native IPC slice of `@oh-my-pi/pi-natives`, as of omp 18.12.2
 * (`packages/natives/native/index.d.ts`, added in a608a9ca07). Only what
 * `peers/transport.ts` calls is declared.
 */
declare module '@oh-my-pi/pi-natives' {
  export interface IpcListenOptions {
    framing: 'lines' | 'raw';
    maxFrameBytes?: number;
  }
  export interface IpcConnectOptions {
    framing: 'lines' | 'raw';
    timeoutMs?: number;
    maxFrameBytes?: number;
  }
  export class IpcConnection {
    static connect(endpoint: string, options: IpcConnectOptions): Promise<IpcConnection>;
    start(onLine: (line: string) => void, onClose: (reason: string | null) => void): void;
    send(frame: string | Uint8Array): boolean;
    end(): void;
    destroy(): void;
  }
  export class IpcServer {
    static listen(
      endpoint: string,
      options: IpcListenOptions,
      onConnection: (connection: IpcConnection) => void
    ): Promise<IpcServer>;
    close(): void;
  }
}
