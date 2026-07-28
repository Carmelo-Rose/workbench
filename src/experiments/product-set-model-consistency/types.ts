export const identityGroupIds = ["female", "male"] as const;
export type IdentityGroupId = (typeof identityGroupIds)[number];

export const experimentSlotIds = ["01", "03", "04", "05", "06", "07", "08"] as const;
export type ExperimentSlotId = (typeof experimentSlotIds)[number];

export type ExperimentStatus =
  | "draft"
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "interrupted";

export type CastingCandidate = {
  id: string;
  groupId: IdentityGroupId;
  index: number;
  imageName: string;
  prompt: string;
  /**
   * `interrupted` means the server stopped after this candidate was marked
   * generating. It is deliberately distinct from a provider failure, so the
   * UI can offer a safe, explicit "continue" action.
   */
  status: "queued" | "generating" | "interrupted" | "succeeded" | "failed";
  attempts: number;
  error?: string;
};

export type CastingRecord = {
  id: string;
  workspaceId: string;
  status: ExperimentStatus;
  provider: "mono-image";
  model: string;
  candidateCountPerGroup: number;
  candidates: CastingCandidate[];
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
};

export type ModelProfile = {
  id: string;
  workspaceId: string;
  displayName: string;
  groupId: IdentityGroupId;
  anchorImageName: "anchor.jpg";
  sourceCastingId: string;
  sourceCandidateId: string;
  prompt: string;
  provider: "mono-image";
  model: string;
  createdAt: number;
};

export type SlotReview = {
  identity: "pending" | "passed" | "failed";
  product: "pending" | "passed" | "failed";
  note?: string;
  updatedAt?: number;
};

export type ExperimentSlot = {
  id: ExperimentSlotId;
  identityGroupId: IdentityGroupId;
  lookId: string;
  colorRank: number;
  status: "queued" | "generating" | "succeeded" | "failed";
  attempts: number;
  imageName: string;
  error?: string;
  review: SlotReview;
};

export type ConsistencyRun = {
  id: string;
  workspaceId: string;
  productId: string;
  productName: string;
  workflowId: string;
  profileIds: Record<IdentityGroupId, string>;
  status: ExperimentStatus;
  stage: "queued" | "classifying" | "generating" | "review" | "completed" | "interrupted";
  provider: "mono-image";
  model: string;
  slots: ExperimentSlot[];
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
};

export type ExperimentProduct = {
  id: string;
  name: string;
  masterCount: number;
  ready: boolean;
  issue?: string;
};

export type ExperimentCatalog = {
  products: ExperimentProduct[];
  profiles: ModelProfile[];
  /** Newest first. Existing castings are restored on dialog open; they are
   * never recreated just because a page was refreshed. */
  castings: CastingRecord[];
  workflows: { id: string; label: string }[];
};
