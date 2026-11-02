import type { CapabilityReport } from "@lake/protocol";

export type DesignProvider = "lanhu";

export interface DesignRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DesignStyleValue = string | number | boolean | null | DesignStyleValue[] | { [key: string]: DesignStyleValue };

export interface DesignNode {
  id: string;
  name: string;
  type: string;
  parentId?: string;
  children: string[];
  bounds?: DesignRect;
  visible?: boolean;
  text?: string;
  assetUrl?: string;
  style?: Record<string, DesignStyleValue>;
  sourceRef?: string;
  metadata?: {
    className?: string;
    role?: string;
    svgAncestor: boolean;
    ancestorDepth: number;
  };
}

export interface DesignAsset {
  id: string;
  name: string;
  kind: "image" | "icon" | "font" | "unknown";
  sourceUrl?: string;
  localPath?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  density?: string;
  downloadPolicy?: "skip-density-variant" | "download-candidate" | "review";
  downloadStatus?: "pending" | "downloaded" | "cached" | "skipped" | "review" | "failed";
  checksum?: string;
  byteSize?: number;
  referenceCount?: number;
}

export interface DesignMeasurementCandidate {
  value: number;
  unit: "px" | "percent" | "number";
  platformUnit?: "pt" | "dp" | "px" | "unknown";
  platform?: "ios" | "android" | "web" | "unknown";
  sourceClass?: string;
  confidence: "candidate" | "confirmed";
}

export interface DesignNavigationItem {
  id: string;
  label: string;
  nodeId?: string;
  parentId?: string;
  parentTab?: string;
  confidence: "candidate" | "confirmed";
}

export interface DesignPageElement {
  id: string;
  label: string;
  role?:
    | "status-time"
    | "back-button"
    | "title"
    | "subtitle"
    | "brand-mark"
    | "count"
    | "label"
    | "favorite-button"
    | "selector"
    | "unknown";
  nodeId?: string;
  type?: string;
  bounds?: DesignRect;
  assetUrl?: string;
  required?: boolean;
  confidence: "candidate" | "confirmed";
}

export interface DesignPageStructure {
  pageName?: string;
  header?: {
    label: string;
    nodeId?: string;
    bounds?: DesignRect;
    elements: DesignPageElement[];
    requiredElementRoles: NonNullable<DesignPageElement["role"]>[];
    confidence: "candidate" | "confirmed";
  };
  primaryTabs: DesignNavigationItem[];
  secondaryTabs: DesignNavigationItem[];
  selectedPrimaryTab?: string;
  selectedSecondaryTab?: string;
  confidence: "candidate" | "confirmed";
  source: "design-json" | "inferred";
  notes: string[];
}

export interface DesignDocumentRevision {
  version: number;
  syncedAt: string;
  sourceUrl: string;
  capabilityStatus: string;
  nodeCount: number;
  assetCount: number;
}

export interface DesignDocumentRevisionSnapshot extends DesignDocumentRevision {
  rootNodeIds: string[];
  nodes: Record<string, DesignNode>;
  assets: Record<string, DesignAsset>;
  measurementCandidates?: DesignMeasurementCandidate[];
}

export interface DesignDocument {
  id: string;
  provider: DesignProvider;
  sourceUrl: string;
  title?: string;
  projectName?: string;
  thumbnailPath?: string;
  /** Official provider-rendered artboard image used only by the desktop preview. */
  previewUrl?: string;
  previewPath?: string;
  syncedAt: string;
  syncVersion: number;
  revisions?: DesignDocumentRevision[];
  revisionSnapshots?: DesignDocumentRevisionSnapshot[];
  adapterVersion: string;
  capabilityReport: CapabilityReport;
  pageIds: string[];
  rootNodeIds: string[];
  nodes: Record<string, DesignNode>;
  assets: Record<string, DesignAsset>;
  pageStructure?: DesignPageStructure;
  measurementCandidates?: DesignMeasurementCandidate[];
  nodeProbe?: {
    source: "lanhu-dom" | "lanhu-structured";
    candidateCount: number;
    truncated: boolean;
    checkedAt: string;
  };
  structuredDataProbe?: {
    status: "not-run" | "candidate" | "partial" | "ready" | "failed";
    resourceCount: number;
    jsonResourceCount: number;
    parsedResourceCount: number;
    nodeCount: number;
    assetCount: number;
    measurementCount: number;
    notes: string[];
  };
}

export interface DesignContext {
  id: string;
  documentId: string;
  /** The document sync this context was created from. Older contexts may omit it. */
  documentSyncedAt?: string;
  nodeIds: string[];
  createdAt: string;
  label?: string;
}

export function createEmptyDesignDocument(input: {
  id: string;
  sourceUrl: string;
  title?: string;
  syncedAt?: string;
  adapterVersion: string;
  capabilityReport: CapabilityReport;
}): DesignDocument {
  return {
    id: input.id,
    provider: "lanhu",
    sourceUrl: input.sourceUrl,
    title: input.title,
    syncedAt: input.syncedAt ?? new Date().toISOString(),
    syncVersion: 1,
    revisions: [],
    adapterVersion: input.adapterVersion,
    capabilityReport: input.capabilityReport,
    pageIds: [],
    rootNodeIds: [],
    nodes: {},
    assets: {},
    measurementCandidates: [],
    nodeProbe: {
      source: "lanhu-dom",
      candidateCount: input.capabilityReport.diagnostics?.nodeCandidates?.length ?? 0,
      truncated: input.capabilityReport.diagnostics?.nodeCandidateLimitReached ?? false,
      checkedAt: input.capabilityReport.checkedAt
    }
  };
}
