export type ProbeStatus = "not-run" | "partial" | "ready" | "failed";

export interface SyncRequest {
  requestId: string;
  source: "lanhu";
  pageUrl: string;
  requestedAt: string;
}

export interface CapabilityReport {
  status: ProbeStatus;
  pageUrl: string;
  pageTitle: string;
  pageIdentity?: {
    projectId?: string;
    imageId?: string;
    teamId?: string;
    pageId?: string;
    resourceType?: string;
  };
  checkedAt: string;
  adapterVersion: string;
  diagnostics?: PageDiagnostics;
  capabilities: {
    pageIdentity: boolean;
    previewImage: boolean;
    nodeTree: boolean;
    measurements: boolean;
    assets: boolean;
  };
  notes: string[];
}

export interface PageDiagnostics {
  readyState: "loading" | "interactive" | "complete" | "unknown";
  renderSurface: "dom" | "canvas" | "svg" | "mixed" | "unknown";
  domElementCount: number;
  nodeMarkerCount: number;
  semanticElementCount: number;
  contentEditableCount: number;
  bodyTextLength: number;
  imageCount: number;
  canvasCount: number;
  svgCount: number;
  iframeCount: number;
  shadowRootCount?: number;
  svgSummaries?: PageSvgSummary[];
  visibleSurfaceSummaries?: PageSurfaceSummary[];
  imageSummaries?: PageImageSummary[];
  annotationSummaries?: PageAnnotationSummary[];
  platformContext?: PagePlatformContext;
  structuredDataProbe?: PageStructuredDataProbe;
  nodeCandidates?: PageNodeCandidate[];
  nodeCandidateLimitReached?: boolean;
}

export interface PageStructuredDataProbe {
  status: "not-run" | "candidate" | "partial" | "ready" | "failed";
  resourceCount: number;
  jsonResourceCount: number;
  parsedResourceCount: number;
  nodeCount: number;
  assetCount: number;
  measurementCount: number;
  resources?: PageStructuredResource[];
  nodes?: PageStructuredNode[];
  assets?: PageStructuredAsset[];
  notes: string[];
}

export interface PageStructuredResource {
  path: string;
  status: number;
  contentType?: string;
  parsed: boolean;
  topLevelKeys?: string[];
}

export interface PageStructuredNode {
  sourcePath: string;
  type?: string;
  name?: string;
  text?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  styleKeys?: string[];
  confidence: "candidate" | "confirmed";
}

export interface PageStructuredAsset {
  sourcePath: string;
  name?: string;
  kind: "image" | "icon" | "font" | "unknown";
  width?: number;
  height?: number;
  confidence: "candidate" | "confirmed";
}

export interface PagePlatformContext {
  label?: string;
  kind: "ios" | "android" | "web" | "unknown";
  designUnit: "pt" | "dp" | "px" | "unknown";
  viewportWidth?: number;
  contentHeight?: number;
  scrollable?: boolean;
  confidence: "candidate" | "confirmed";
  source: "lanhu-platform-selector";
}

export interface PageSurfaceSummary {
  tagName: string;
  id?: string;
  className?: string;
  role?: string;
  width: number;
  height: number;
  childElementCount: number;
  imageDescendantCount: number;
  canvasDescendantCount: number;
  svgDescendantCount: number;
  backgroundImage: boolean;
}

export interface PageImageSummary {
  id?: string;
  className?: string;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  visible: boolean;
}

export interface PageAnnotationSummary {
  tagName: string;
  id?: string;
  className?: string;
  role?: string;
  width: number;
  height: number;
  textLength: number;
  numericValues: number[];
  measurements?: PageAnnotationMeasurement[];
  likelyMeasurements: number[];
  pxValueCount: number;
  childElementCount: number;
  visible: boolean;
}

export interface PageAnnotationMeasurement {
  value: number;
  unit: "px" | "percent" | "rem" | "em" | "rpx" | "number";
}

export interface PageSvgSummary {
  id?: string;
  className?: string;
  width: number;
  height: number;
  viewBox?: string;
  elementCount: number;
  visible: boolean;
}

export interface PageNodeCandidate {
  marker: string;
  markerType: "data-node-id" | "data-id" | "data-layer-id" | "data-element-id";
  tagName: string;
  className?: string;
  role?: string;
  svgAncestor: boolean;
  ancestorDepth: number;
  classification: "page-ui" | "design-candidate" | "unknown";
  name?: string;
  parentMarker?: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  visible: boolean;
}

export interface SyncResult {
  request: SyncRequest;
  report: CapabilityReport;
}

export interface SyncRecord extends SyncResult {
  savedAt: string;
}

/**
 * Message types reserved for a future browser-extension transport.
 * The first implementation is deliberately transport-agnostic: the same
 * envelope can later be carried by Native Messaging, a local WebSocket, or a
 * browser extension bridge without changing the design data model.
 */
export const LAKE_BRIDGE_EXTENSION_PROTOCOL = "lake-bridge-extension" as const;
export const LAKE_BRIDGE_EXTENSION_PROTOCOL_VERSION = 1 as const;

export type ExtensionBrowser = "chrome" | "edge" | "brave" | "safari" | "unknown";
export type ExtensionMessageType =
  | "extension.hello"
  | "desktop.hello"
  | "page.snapshot.request"
  | "page.snapshot.response"
  | "sync.request"
  | "sync.response"
  | "capability.status"
  | "protocol.error";

export interface ExtensionMessageBase<TType extends ExtensionMessageType = ExtensionMessageType> {
  protocol: typeof LAKE_BRIDGE_EXTENSION_PROTOCOL;
  protocolVersion: typeof LAKE_BRIDGE_EXTENSION_PROTOCOL_VERSION;
  type: TType;
  requestId: string;
  sentAt: string;
}

export interface ExtensionPageReference {
  url: string;
  title?: string;
  projectId?: string;
  imageId?: string;
  teamId?: string;
  pageId?: string;
}

export interface ExtensionHelloMessage extends ExtensionMessageBase<"extension.hello"> {
  payload: {
    extensionVersion: string;
    browser: ExtensionBrowser;
    page?: ExtensionPageReference;
  };
}

export interface DesktopHelloMessage extends ExtensionMessageBase<"desktop.hello"> {
  payload: {
    desktopVersion: string;
    supportedProtocolVersions: readonly [typeof LAKE_BRIDGE_EXTENSION_PROTOCOL_VERSION];
    capabilities: {
      pageSnapshot: boolean;
      sync: boolean;
      diagnostics: boolean;
    };
  };
}

export interface PageSnapshotRequestMessage extends ExtensionMessageBase<"page.snapshot.request"> {
  payload: {
    includeDiagnostics: boolean;
  };
}

export interface PageSnapshotResponseMessage extends ExtensionMessageBase<"page.snapshot.response"> {
  payload: {
    page: ExtensionPageReference;
    diagnostics?: PageDiagnostics;
    /** Structured design data remains owned by the desktop API adapter. */
    structuredDataAvailable: boolean;
  };
}

export interface ExtensionSyncRequestMessage extends ExtensionMessageBase<"sync.request"> {
  payload: {
    page: ExtensionPageReference;
    requestedAt: string;
    /** Credentials are intentionally not part of the extension protocol. */
    credentialTransport: "desktop-session" | "extension-session" | "none";
  };
}

export interface ExtensionSyncResponseMessage extends ExtensionMessageBase<"sync.response"> {
  payload: {
    status: ProbeStatus;
    syncRecord?: SyncResult;
    notes: string[];
  };
}

export interface CapabilityStatusMessage extends ExtensionMessageBase<"capability.status"> {
  payload: {
    browser: ExtensionBrowser;
    connected: boolean;
    page?: ExtensionPageReference;
    capabilities: {
      pageSnapshot: boolean;
      sync: boolean;
      diagnostics: boolean;
    };
    notes: string[];
  };
}

export interface ProtocolErrorMessage extends ExtensionMessageBase<"protocol.error"> {
  payload: {
    code:
      | "invalid-message"
      | "unsupported-version"
      | "missing-request-id"
      | "unauthorized"
      | "not-connected"
      | "unsupported-operation";
    message: string;
    retryable: boolean;
  };
}

export type ExtensionProtocolMessage =
  | ExtensionHelloMessage
  | DesktopHelloMessage
  | PageSnapshotRequestMessage
  | PageSnapshotResponseMessage
  | ExtensionSyncRequestMessage
  | ExtensionSyncResponseMessage
  | CapabilityStatusMessage
  | ProtocolErrorMessage;

export interface ProtocolParseError {
  code: "invalid-message" | "unsupported-version" | "missing-request-id";
  message: string;
}

export type ProtocolParseResult =
  | { ok: true; value: ExtensionProtocolMessage }
  | { ok: false; error: ProtocolParseError };

export function createExtensionProtocolMessage<
  TType extends ExtensionMessageType,
  TPayload
>(
  type: TType,
  requestId: string,
  payload: TPayload,
  sentAt = new Date().toISOString()
): ExtensionMessageBase<TType> & { payload: TPayload } {
  return {
    protocol: LAKE_BRIDGE_EXTENSION_PROTOCOL,
    protocolVersion: LAKE_BRIDGE_EXTENSION_PROTOCOL_VERSION,
    type,
    requestId,
    sentAt,
    payload
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Runtime boundary for messages received from an untrusted extension. */
export function parseExtensionProtocolMessage(input: unknown): ProtocolParseResult {
  if (!isRecord(input) || input.protocol !== LAKE_BRIDGE_EXTENSION_PROTOCOL) {
    return { ok: false, error: { code: "invalid-message", message: "消息不是受支持的扩展协议对象。" } };
  }
  if (input.protocolVersion !== LAKE_BRIDGE_EXTENSION_PROTOCOL_VERSION) {
    return { ok: false, error: { code: "unsupported-version", message: "扩展协议版本不受支持。" } };
  }
  if (!hasNonEmptyString(input.requestId)) {
    return { ok: false, error: { code: "missing-request-id", message: "扩展协议消息缺少 requestId。" } };
  }
  if (!hasNonEmptyString(input.sentAt) || !hasNonEmptyString(input.type) || !isRecord(input.payload)) {
    return { ok: false, error: { code: "invalid-message", message: "扩展协议消息缺少 type、sentAt 或 payload。" } };
  }

  const supportedTypes: readonly ExtensionMessageType[] = [
    "extension.hello",
    "desktop.hello",
    "page.snapshot.request",
    "page.snapshot.response",
    "sync.request",
    "sync.response",
    "capability.status",
    "protocol.error"
  ];
  if (!supportedTypes.includes(input.type as ExtensionMessageType)) {
    return { ok: false, error: { code: "invalid-message", message: "扩展协议消息类型不受支持。" } };
  }

  return { ok: true, value: input as unknown as ExtensionProtocolMessage };
}

export { ExtensionProtocolSession } from "./extension";
export type {
  ExtensionSessionCapabilities,
  ExtensionSessionResult,
  ExtensionSessionState
} from "./extension";
export {
  NativeMessagingFrameDecoder,
  NativeMessagingProtocolError,
  NATIVE_MESSAGING_MAX_MESSAGE_BYTES,
  decodeNativeMessagingFrames,
  encodeNativeMessagingMessage
} from "./native-messaging";
export type { NativeMessagingDecodeResult } from "./native-messaging";
