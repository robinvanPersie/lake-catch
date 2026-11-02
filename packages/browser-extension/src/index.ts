import {
  createExtensionProtocolMessage,
  parseExtensionProtocolMessage,
  type DesktopHelloMessage,
  type ExtensionBrowser,
  type ExtensionHelloMessage,
  type ExtensionPageReference,
  type ExtensionProtocolMessage,
  type PageDiagnostics,
  type PageSnapshotRequestMessage,
  type ProtocolErrorMessage
} from "@lake/protocol";

export interface BrowserExtensionPageSnapshot {
  page: ExtensionPageReference;
  diagnostics?: PageDiagnostics;
  structuredDataAvailable: boolean;
}

export interface BrowserExtensionPageProvider {
  getCurrentPage(includeDiagnostics: boolean): Promise<BrowserExtensionPageSnapshot>;
}

export interface BrowserExtensionClientOptions {
  extensionVersion: string;
  browser: ExtensionBrowser;
  pageProvider: BrowserExtensionPageProvider;
  send(message: ExtensionProtocolMessage): void | Promise<void>;
}

export type BrowserExtensionReceiveResult =
  | { accepted: true; response?: ExtensionProtocolMessage }
  | { accepted: false; response: ProtocolErrorMessage };

/**
 * Browser-neutral extension core. Browser APIs and Native Messaging are
 * injected so this package remains testable without a browser runtime.
 */
export class BrowserExtensionClient {
  private requestCounter = 0;
  private connected = false;

  constructor(private readonly options: BrowserExtensionClientOptions) {}

  isConnected(): boolean {
    return this.connected;
  }

  async connect(page?: ExtensionPageReference): Promise<ExtensionHelloMessage> {
    const hello: ExtensionHelloMessage = {
      ...createExtensionProtocolMessage("extension.hello", this.nextRequestId(), {
        extensionVersion: this.options.extensionVersion,
        browser: this.options.browser,
        ...(page ? { page } : {})
      }),
      type: "extension.hello"
    };
    await this.options.send(hello);
    return hello;
  }

  async receive(input: unknown): Promise<BrowserExtensionReceiveResult> {
    const parsed = parseExtensionProtocolMessage(input);
    if (!parsed.ok) {
      return { accepted: false, response: this.errorMessage("invalid-message", parsed.error.message, false) };
    }

    switch (parsed.value.type) {
      case "desktop.hello":
        return this.acceptDesktopHello(parsed.value);
      case "page.snapshot.request":
        return this.respondToSnapshotRequest(parsed.value);
      case "protocol.error":
        this.connected = false;
        return { accepted: true };
      default:
        return {
          accepted: false,
          response: this.errorMessage(
            "unsupported-operation",
            `扩展端不能接收 ${parsed.value.type} 消息。`,
            false,
            parsed.value.requestId
          )
        };
    }
  }

  disconnect(): void {
    this.connected = false;
  }

  private acceptDesktopHello(message: DesktopHelloMessage): BrowserExtensionReceiveResult {
    this.connected = true;
    return { accepted: true };
  }

  private async respondToSnapshotRequest(
    message: PageSnapshotRequestMessage
  ): Promise<BrowserExtensionReceiveResult> {
    if (!this.connected) {
      return {
        accepted: false,
        response: this.errorMessage("not-connected", "桌面端尚未完成握手。", false, message.requestId)
      };
    }

    try {
      const snapshot = await this.options.pageProvider.getCurrentPage(message.payload.includeDiagnostics);
      const response: ExtensionProtocolMessage = {
        ...createExtensionProtocolMessage("page.snapshot.response", message.requestId, snapshot),
        type: "page.snapshot.response"
      };
      await this.options.send(response);
      return { accepted: true, response };
    } catch (error) {
      const response = this.errorMessage(
        "invalid-message",
        error instanceof Error ? error.message : "读取当前页面失败。",
        true,
        message.requestId
      );
      await this.options.send(response);
      return { accepted: false, response };
    }
  }

  private errorMessage(
    code: ProtocolErrorMessage["payload"]["code"],
    message: string,
    retryable: boolean,
    requestId = this.nextRequestId()
  ): ProtocolErrorMessage {
    return {
      ...createExtensionProtocolMessage("protocol.error", requestId, { code, message, retryable }),
      type: "protocol.error"
    };
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `extension-${Date.now()}-${this.requestCounter}`;
  }
}

export { attachBrowserExtensionPort } from "./port";
export type { AttachedBrowserExtension, ExtensionMessagePort } from "./port";
