export interface DreamConfig {
  agentFolder: string;
  agentDir: string;
  isMain: boolean;
}

export interface PhaseCounts {
  lightCount: number;
  remCount: number;
  deepPromoted: number;
  sharedPromoted?: number;
}

export interface PromotedEngram {
  candidate_id: number;
  agent_folder: string;
  snippet: string;
  score: number;
  theme_tags: string[];
}
