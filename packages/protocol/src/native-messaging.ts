const nativeMessagingTextEncoder = new TextEncoder();
const nativeMessagingTextDecoder = new TextDecoder();

export const NATIVE_MESSAGING_MAX_MESSAGE_BYTES = 1024 * 1024;

export interface NativeMessagingDecodeResult {
  messages: unknown[];
  remainder: Uint8Array;
}

export class NativeMessagingProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeMessagingProtocolError";
  }
}

/** Encode one Chrome-compatible Native Messaging frame. */
export function encodeNativeMessagingMessage(
  message: unknown,
  maxBytes = NATIVE_MESSAGING_MAX_MESSAGE_BYTES
): Uint8Array {
  let json: string;
  try {
    json = JSON.stringify(message);
  } catch {
    throw new NativeMessagingProtocolError("Native Messaging 消息无法序列化为 JSON。");
  }
  if (json === undefined) {
    throw new NativeMessagingProtocolError("Native Messaging 消息不能是 undefined。");
  }

  const body = nativeMessagingTextEncoder.encode(json);
  if (body.byteLength > maxBytes) {
    throw new NativeMessagingProtocolError(`Native Messaging 消息超过 ${maxBytes} bytes 限制。`);
  }

  const frame = new Uint8Array(4 + body.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, body.byteLength, true);
  frame.set(body, 4);
  return frame;
}

/** Decode as many complete frames as are available, retaining an incomplete tail. */
export function decodeNativeMessagingFrames(
  input: Uint8Array,
  maxBytes = NATIVE_MESSAGING_MAX_MESSAGE_BYTES
): NativeMessagingDecodeResult {
  const messages: unknown[] = [];
  let offset = 0;

  while (input.byteLength - offset >= 4) {
    const view = new DataView(input.buffer, input.byteOffset + offset, 4);
    const bodyLength = view.getUint32(0, true);
    if (bodyLength > maxBytes) {
      throw new NativeMessagingProtocolError(`Native Messaging 消息超过 ${maxBytes} bytes 限制。`);
    }
    const frameLength = 4 + bodyLength;
    if (input.byteLength - offset < frameLength) {
      break;
    }

    const body = input.subarray(offset + 4, offset + frameLength);
    let parsed: unknown;
    try {
      parsed = JSON.parse(nativeMessagingTextDecoder.decode(body));
    } catch {
      throw new NativeMessagingProtocolError("Native Messaging 消息不是有效的 JSON。");
    }
    messages.push(parsed);
    offset += frameLength;
  }

  return { messages, remainder: input.slice(offset) };
}

export class NativeMessagingFrameDecoder {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array();

  constructor(private readonly maxBytes = NATIVE_MESSAGING_MAX_MESSAGE_BYTES) {}

  push(input: Uint8Array): unknown[] {
    const combined = new Uint8Array(this.pending.byteLength + input.byteLength);
    combined.set(this.pending);
    combined.set(input, this.pending.byteLength);
    const decoded = decodeNativeMessagingFrames(combined, this.maxBytes);
    this.pending = decoded.remainder;
    return decoded.messages;
  }

  reset(): void {
    this.pending = new Uint8Array();
  }
}
