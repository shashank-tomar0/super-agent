// ============================================================
// VLESS — Core Type Definitions
// The shared language between all system components
// ============================================================

// ── Page Perception ──────────────────────────────────────────

/** A detected interactive element on the page */
export interface PageElement {
  id: string;
  tag: string;
  role: string;
  text: string;
  label: string;
  placeholder: string;
  ariaLabel: string;
  type: string;
  rect: DOMRect;
  isVisible: boolean;
  isInteractive: boolean;
  isDisabled: boolean;
  confidence: number;
  source: "dom" | "vision" | "hybrid";
}

/** Complete representation of the current page state */
export interface PageState {
  url: string;
  title: string;
  timestamp: number;
  elements: PageElement[];
  forms: FormData[];
  textContent: string;
  metadata: PageMetadata;
  confidence: number;
  perceptionTime: number; // ms
}

export interface FormData {
  id: string;
  action: string;
  method: string;
  fields: FormField[];
}

export interface FormField {
  name: string;
  id: string;
  type: string;
  value: string;
  required: boolean;
  maxLength: number;
  pattern: string;
  options: string[];
  rect: DOMRect;
  label: string;
  filledByUser: boolean;
  /** Selection state for radio/checkbox. Undefined for other input types. */
  checked?: boolean;
}

export interface PageMetadata {
  hasCAPTCHA: boolean;
  hasHoneypot: boolean;
  isSecure: boolean;
  hasFileUpload: boolean;
  hasPaymentForm: boolean;
  formCount: number;
  totalElements: number;
  interactiveElements: number;
}

// ── Agent Actions ────────────────────────────────────────────

export type ActionType =
  | "click"
  | "type"
  | "scroll"
  | "navigate"
  | "select"
  | "hover"
  | "press_key"
  | "upload_file"
  | "wait"
  | "go_back"
  | "close_tab"
  | "switch_tab";

export interface AgentAction {
  id: string;
  type: ActionType;
  target?: string; // element selector or ID
  value?: string;
  coordinates?: { x: number; y: number };
  key?: string;
  filePath?: string;
  timeout?: number;
  retries: number;
  maxRetries: number;
}

export interface ActionResult {
  actionId: string;
  success: boolean;
  error?: string;
  executionTime: number; // ms
  pageStateBefore: PageState;
  pageStateAfter: PageState;
  verificationSignals: VerificationSignal[];
}

// ── Agent Brain ──────────────────────────────────────────────

export type AgentStatus =
  | "idle"
  | "analyzing"
  | "planning"
  | "executing"
  | "verifying"
  | "recovering"
  | "completed"
  | "failed"
  | "paused"
  | "waiting_for_user";

export interface AgentTask {
  id: string;
  description: string;
  status: AgentStatus;
  plan: ActionPlan;
  currentStep: number;
  totalSteps: number;
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
}

export interface ActionPlan {
  steps: PlannedAction[];
  estimatedTime: number;
  riskLevel: "low" | "medium" | "high";
  requiresConfirmation: boolean;
  dataMappings: DataMapping[];
}

export interface PlannedAction {
  index: number;
  action: AgentAction;
  reasoning: string;
  confidence: number;
  verification: string;
  risk: "low" | "medium" | "high";
}

export interface DataMapping {
  fieldName: string;
  dataSource: string;
  value: string;
  confidence: number;
  fallback?: string;
}

// ── Reasoning Trace ──────────────────────────────────────────

export interface ReasoningStep {
  timestamp: number;
  phase: "observe" | "think" | "act" | "verify" | "reflect";
  input: string;
  reasoning: string;
  output: string;
  confidence: number;
  duration: number; // ms
}

// ── Verification ─────────────────────────────────────────────

export interface VerificationSignal {
  type:
    | "dom_diff"
    | "url_change"
    | "network_request"
    | "visual_diff"
    | "accessibility_tree"
    | "error_check";
  passed: boolean;
  confidence: number;
  details: string;
}

export interface VerificationResult {
  overallConfidence: number;
  passed: boolean;
  signals: VerificationSignal[];
  unexpectedChanges: string[];
}

// ── Memory ───────────────────────────────────────────────────

export interface SiteMemory {
  domain: string;
  pages: Map<string, PageMemory>;
  navigationFlow: NavigationGraph;
  formSchemas: Map<string, FormSchema>;
  elementPositions: Map<string, ElementPosition>;
  successPatterns: ActionPattern[];
  failurePatterns: ActionPattern[];
  visitCount: number;
  lastVisited: number;
}

export interface PageMemory {
  url: string;
  purpose: string;
  elements: PageElement[];
  lastSeen: number;
  visitCount: number;
}

export interface NavigationGraph {
  nodes: string[];
  edges: NavigationEdge[];
}

export interface NavigationEdge {
  from: string;
  to: string;
  trigger: string;
  confidence: number;
}

export interface FormSchema {
  id: string;
  name: string;
  fields: SchemaField[];
  validationRules: ValidationRule[];
  semanticMapping: Record<string, string>;
}

export interface SchemaField {
  name: string;
  id: string;
  type: string;
  required: boolean;
  pattern: string;
  maxLength: number;
  semanticCategory: string;
}

export interface ValidationRule {
  fieldName: string;
  rule: string;
  description: string;
}

export interface ElementPosition {
  selector: string;
  lastKnownRect: DOMRect;
  confidence: number;
  lastSeen: number;
}

export interface ActionPattern {
  action: AgentAction;
  successRate: number;
  avgExecutionTime: number;
  lastUsed: number;
}

// ── Visual Debug ─────────────────────────────────────────────

export interface DebugOverlay {
  boundingBoxes: BoundingBox[];
  activeAction: AgentAction | null;
  reasoningTrace: ReasoningStep[];
  pageState: PageState;
  verificationResult: VerificationResult | null;
}

export interface BoundingBox {
  rect: DOMRect;
  label: string;
  confidence: number;
  color: "green" | "yellow" | "orange" | "red";
  phase: "perception" | "action" | "verification";
}

// ── Messaging ────────────────────────────────────────────────

export type MessageType =
  | "PERCEIVE_PAGE"
  | "PAGE_STATE"
  | "EXECUTE_ACTION"
  | "ACTION_RESULT"
  | "START_TASK"
  | "TASK_STATUS"
  | "TASK_COMPLETE"
  | "UPDATE_DEBUG_OVERLAY"
  | "GET_MEMORY"
  | "SAVE_MEMORY"
  | "USER_INPUT"
  | "CANCEL_TASK"
  | "TOGGLE_OVERLAY"
  | "CHECK_LLM"
  | "GET_LLM_STATUS"
  | "GET_PRIVACY_STATS"
  | "EXECUTE_PIPELINE"
  | "PIPELINE_COMPLETE"
  | "PIPELINE_PROGRESS"
  | "CHECK_PROVIDERS"
  | "DO_CAPTURE_TAB"
  | "CAPTURE_SCREENSHOT"
  | "CAPTURE_FULL_PAGE"
  | "GET_TRIPWIRE_STATS"
  | "REPORT_PAGE_EGRESS"
  | "INJECT_REDACTION_CSS"
  | "REMOVE_REDACTION_CSS"
  | "SHOW_PII_OVERLAY"
  | "HIDE_PII_OVERLAY"
  | "SHOW_PIPELINE_PANEL"
  | "UPDATE_PIPELINE_PANEL"
  // ── On-device runtime (offscreen ML host) ──
  | "GET_BACKEND"
  | "GET_MODEL_STATUSES"
  | "WARM_MODELS"
  | "RUN_OCR"
  // ── Provider management ──
  | "GET_PROVIDERS"
  | "GET_ACTIVE_PROVIDER"
  | "SAVE_PROVIDER"
  | "SET_ACTIVE_PROVIDER"
  | "TEST_PROVIDERS";

export interface Message<T = unknown> {
  type: MessageType;
  payload: T;
  source: "sidepanel" | "content" | "background";
  timestamp: number;
}
