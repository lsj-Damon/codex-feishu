import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';

import * as Lark from '@larksuiteoapi/node-sdk';

import type { AppConfig } from '../../core/config/index.js';
import type { AppLogger } from '../../core/logger/logger.js';
import type { FeishuEventHandler } from './types.js';

export class FeishuLongConnection {
  private wsClient: any;
  private httpServer: HttpServer | null = null;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger
  ) {}

  public async start(handler: FeishuEventHandler): Promise<void> {
    const dispatcher = this.createEventDispatcher(handler);

    if (this.config.feishu.connectionMode === 'webhook') {
      await this.startWebhookRuntime(dispatcher);
      this.logger.info('feishu webhook runtime started', {
        mode: this.config.feishu.connectionMode,
        domain: this.config.feishu.domain,
        bindHost: this.config.feishu.bindHost,
        bindPort: this.config.feishu.bindPort,
        callbackPath: this.config.feishu.callbackPath,
        publicBaseUrl: this.config.feishu.publicBaseUrl ?? null
      });
      return;
    }

    await this.startWebsocketRuntime(dispatcher);
    this.logger.info('feishu websocket runtime started', {
      mode: this.config.feishu.connectionMode,
      domain: this.config.feishu.domain
    });
  }

  public async stop(): Promise<void> {
    if (typeof this.wsClient?.close === 'function') {
      this.wsClient.close({ force: true });
      this.wsClient = null;
      this.logger.info('feishu websocket runtime stopped');
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = null;
      this.logger.info('feishu webhook runtime stopped');
    }
  }

  private createEventDispatcher(handler: FeishuEventHandler): any {
    const DispatcherCtor = (Lark as any).EventDispatcher;
    return new DispatcherCtor({
      encryptKey: this.config.feishu.encryptKey,
      verificationToken: this.config.feishu.verificationToken,
      loggerLevel: (Lark as any).LoggerLevel?.error
    }).register({
      'im.message.receive_v1': async (payload: unknown) => {
        await handler(payload as any);
      }
    });
  }

  private async startWebsocketRuntime(dispatcher: any): Promise<void> {
    const WSClientCtor = (Lark as any).WSClient;
    this.wsClient = new WSClientCtor({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      domain: this.getLarkDomain(),
      loggerLevel: (Lark as any).LoggerLevel?.error,
      autoReconnect: true
    });

    await this.wsClient.start({
      eventDispatcher: dispatcher
    });
  }

  private async startWebhookRuntime(dispatcher: any): Promise<void> {
    const adaptDefault = (Lark as any).adaptDefault;
    const adapter = adaptDefault(this.config.feishu.callbackPath, dispatcher, {
      autoChallenge: true
    });

    this.httpServer = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const url = req.url || '/';

        if (req.method === 'GET' && url === '/healthz') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mode: 'webhook' }));
          return;
        }

        void adapter(req, res);
      }
    );

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.once('error', reject);
      this.httpServer?.listen(
        this.config.feishu.bindPort,
        this.config.feishu.bindHost,
        () => resolve()
      );
    });
  }

  private getLarkDomain(): unknown {
    return this.config.feishu.domain === 'lark'
      ? (Lark as any).Domain?.Lark
      : (Lark as any).Domain?.Feishu;
  }
}
