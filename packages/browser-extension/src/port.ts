import {
  BrowserExtensionClient,
  type BrowserExtensionClientOptions
} from "./index";
import type { ExtensionPageReference, ExtensionProtocolMessage } from "@lake/protocol";

export interface ExtensionMessagePort {
  postMessage(message: ExtensionProtocolMessage): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  onDisconnect?: {
    addListener(listener: () => void): void;
  };
}

export interface AttachedBrowserExtension {
  client: BrowserExtensionClient;
  disconnect(): void;
}

/**
 * Adapts a browser runtime.Port or Native Messaging-like port to the shared
 * extension client. The port implementation remains outside this package.
 */
export function attachBrowserExtensionPort(
  options: Omit<BrowserExtensionClientOptions, "send">,
  port: ExtensionMessagePort,
  page?: ExtensionPageReference
): AttachedBrowserExtension {
  const client = new BrowserExtensionClient({
    ...options,
    send: (message) => port.postMessage(message)
  });

  port.onMessage.addListener((message) => {
    void client.receive(message).then((result) => {
      if (!result.accepted) {
        port.postMessage(result.response);
      }
    });
  });
  port.onDisconnect?.addListener(() => client.disconnect());

  void client.connect(page);
  return {
    client,
    disconnect: () => client.disconnect()
  };
}
