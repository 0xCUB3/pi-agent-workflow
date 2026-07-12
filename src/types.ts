export type WorkerKind = "fast" | "implement" | "design" | "vision" | "research" | "trivial";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type WorkerProfile = {
  kind: WorkerKind;
  label: string;
  model: string;
  thinking: ThinkingLevel;
  fallback?: string;
  description: string;
};

export type WorkflowConfig = {
  enabled: boolean;
  maxConcurrent: number;
  timeoutMs: number;
  maxOutputChars: number;
  maxRetries: number;
  persistArtifacts: boolean;
  profiles: Record<WorkerKind, WorkerProfile>;
};

export type RouteInput = {
  task: string;
  hasImages?: boolean;
  imageCount?: number;
};

export type RouteDecision = {
  kind: WorkerKind;
  reason: string;
  profile: WorkerProfile;
};

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type Job = {
  id: string;
  task: string;
  decision: RouteDecision;
  status: JobStatus;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  output?: string;
  error?: string;
  exitCode?: number;
  artifactDir?: string;
  currentTool?: string;
  lastEvent?: string;
  toolUses?: number;
  toolsUsed?: string[];
  lastMessage?: string;
  messageCount?: number;
};

export type ChildResult = {
  ok: boolean;
  output: string;
  error?: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  usage?: { input?: number; output?: number; total?: number };
  rawJsonl?: string;
  stderr?: string;
};