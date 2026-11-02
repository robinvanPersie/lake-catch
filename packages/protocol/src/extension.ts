import {
  createExtensionProtocolMessage,
  parseExtensionProtocolMessage,
  type CapabilityStatusMessage,
  type DesktopHelloMessage,
  type ExtensionBrowser,
  type ExtensionHelloMessage,
  type ExtensionPageReference,
  type ExtensionProtocolMessage,
  type ExtensionSyncResponseMessage,
  type PageSnapshotResponseMessage,
  type ProtocolErrorMessage
} from "./index";

export interface ExtensionSessionCapabilities {
  pageSnapshot: boolean;
  sync: boolean;
  diagnostics: boolean;
}

export interface ExtensionSessionState {
  connected: boolean;
  browser?: ExtensionBrowser;
  extensionVersion?: string;
  page?: ExtensionPageReference;
  capabilities: ExtensionSessionCapabilities;
  lastSeenAt?: string;
}

export type ExtensionSessionResult =
  | { accepted: true; state: ExtensionSessionState; response?: ExtensionProtocolMessage }
  | { accepted: false; state: ExtensionSessionState; response: ProtocolErrorMessage };

const defaultCapabilities: ExtensionSessionCapabilities = {
  pageSnapshot: false,
  sync: false,
  diagnostics: false
};

function cloneState(state: ExtensionSessionState): ExtensionSessionState {
  return {
    ...state,
    capabilities: { ...state.capabilities },
    page: state.page ? { ...state.page } : undefined
  };
}

/**
 * Transport-independent session state for a future browser extension.
 * It intentionally does not read, store, or forward credentials.
 */
export class ExtensionProtocolSession {
  private state: ExtensionSessionState = {
    connected: false,
    capabilities: { ...defaultCapabilities }
  };

  constructor(
    private readonly desktopVersion: string,
    private readonly desktopCapabilities: ExtensionSessionCapabilities = {
      pageSnapshot: true,
      sync: true,
      diagnostics: true
    }
  ) {}

  getState(): ExtensionSessionState {
    return cloneState(this.state);
  }

  receive(input: unknown): ExtensionSessionResult {
    const parsed = parseExtensionProtocolMessage(input);
    if (!parsed.ok) {
      return {
        accepted: false,
        state: this.getState(),
        response: this.errorMessage("invalid-message", parsed.error.message, false, "invalid-message")
      };
    }

    const message = parsed.value;
    switch (message.type) {
      case "extension.hello":
        return this.acceptHello(message);
      case "page.snapshot.response":
        return this.acceptPageSnapshot(message);
      case "sync.response":
        return this.acceptSyncResponse(message);
      case "capability.status":
        return this.acceptCapabilityStatus(message);
      case "protocol.error":
        this.state.connected = false;
        this.state.lastSeenAt = message.sentAt;
        return { accepted: true, state: this.getState() };
      default:
        return {
          accepted: false,
          state: this.getState(),
          response: this.errorMessage(
            "unsupported-operation",
            `桌面端会话不能接收 ${message.type} 消息。`,
            false,
            message.requestId
          )
        };
    }
  }

  disconnect(): ExtensionSessionState {
    this.state = {
      connected: false,
      capabilities: { ...defaultCapabilities }
    };
    return this.getState();
  }

  private acceptHello(message: ExtensionHelloMessage): ExtensionSessionResult {
    this.state = {
      connected: true,
      browser: message.payload.browser,
      extensionVersion: message.payload.extensionVersion,
      page: message.payload.page,
      capabilities: { ...this.desktopCapabilities },
      lastSeenAt: message.sentAt
    };
    const response: DesktopHelloMessage = {
      ...createExtensionProtocolMessage("desktop.hello", message.requestId, {
        desktopVersion: this.desktopVersion,
        supportedProtocolVersions: [1] as const,
        capabilities: this.desktopCapabilities
      }),
      type: "desktop.hello"
    };
    return { accepted: true, state: this.getState(), response };
  }

  private acceptPageSnapshot(message: PageSnapshotResponseMessage): ExtensionSessionResult {
    if (!this.state.connected) {
      return {
        accepted: false,
        state: this.getState(),
        response: this.errorMessage("not-connected", "扩展尚未完成握手。", false, message.requestId)
      };
    }
    this.state.page = { ...message.payload.page };
    this.state.lastSeenAt = message.sentAt;
    return { accepted: true, state: this.getState() };
  }

  private acceptSyncResponse(message: ExtensionSyncResponseMessage): ExtensionSessionResult {
    if (!this.state.connected) {
      return {
        accepted: false,
        state: this.getState(),
        response: this.errorMessage("not-connected", "扩展尚未完成握手。", false, message.requestId)
      };
    }
    this.state.lastSeenAt = message.sentAt;
    return { accepted: true, state: this.getState() };
  }

  private acceptCapabilityStatus(message: CapabilityStatusMessage): ExtensionSessionResult {
    this.state.connected = message.payload.connected;
    this.state.browser = message.payload.browser;
    this.state.page = message.payload.page ? { ...message.payload.page } : this.state.page;
    this.state.capabilities = { ...message.payload.capabilities };
    this.state.lastSeenAt = message.sentAt;
    return { accepted: true, state: this.getState() };
  }

  private errorMessage(
    code: ProtocolErrorMessage["payload"]["code"],
    message: string,
    retryable: boolean,
    requestId: string
  ): ProtocolErrorMessage {
    return {
      ...createExtensionProtocolMessage("protocol.error", requestId, { code, message, retryable }),
      type: "protocol.error"
    };
  }
}
