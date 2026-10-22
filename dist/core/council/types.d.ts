/**
 * Council (Conference Room) types.
 *
 * All participants share the same context and speak in a meeting-like flow:
 * each contribution goes into the transcript, findings accumulate, decisions
 * are recorded, and a chairperson synthesises everything into meeting minutes.
 */
export type CouncilMode = 'parallel' | 'sequential' | 'debate' | 'brainstorm';
export type ParticipantKind = 'tool' | 'op' | 'agent';
export type ContributionType = 'observation' | 'analysis' | 'question' | 'concern' | 'suggestion' | 'agreement' | 'disagreement' | 'evidence' | 'decision-proposal' | 'action-item';
export interface CouncilParticipant {
    id: string;
    name: string;
    role: string;
    title?: string;
    kind: ParticipantKind;
    /** Tool id or operation id to invoke. */
    target?: string;
    /** Role-specific instructions / system prompt. */
    goal: string;
    /** Extra arguments passed when invoking target. */
    args?: string[];
    /** Operation input template merged into the call. */
    with?: Record<string, unknown>;
    /** Can this participant speak first / in a specific order? */
    order?: number;
    /** Is this participant the chairperson? */
    chair?: boolean;
    /** Custom persona description shown in transcript. */
    persona?: string;
    /** Timeout for this participant's turn. */
    timeoutMs?: number;
}
export interface CouncilInput {
    agenda: string;
    context?: Record<string, unknown>;
    files?: string[];
    urls?: string[];
    constraints?: string[];
}
export interface TranscriptEntry {
    id: string;
    at: number;
    round: number;
    participantId: string;
    participantName: string;
    participantRole: string;
    participantTitle?: string;
    type: ContributionType;
    /** The actual contribution (analysis, findings etc.). */
    content: string;
    /** Structured evidence supporting the contribution. */
    evidence?: Array<{
        source: string;
        detail: string;
    }>;
    /** References to other participants' points. */
    references?: string[];
    /** Tags for quick filtering. */
    tags?: string[];
    /** Raw output from the underlying tool/op. */
    raw?: unknown;
}
export interface Finding {
    id: string;
    at: number;
    round: number;
    raisedBy: string;
    raisedByRole: string;
    severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
    category?: string;
    title: string;
    detail: string;
    evidence?: Array<{
        source: string;
        detail: string;
    }>;
    related?: string[];
}
export interface Decision {
    id: string;
    at: number;
    round: number;
    proposedBy: string;
    agreedBy: string[];
    title: string;
    rationale: string;
    impact?: string;
}
export interface ActionItem {
    id: string;
    at: number;
    round: number;
    assignee?: string;
    title: string;
    detail: string;
    priority?: 'urgent' | 'high' | 'medium' | 'low';
    due?: string;
}
export interface Question {
    id: string;
    at: number;
    round: number;
    askedBy: string;
    question: string;
    answered?: boolean;
    answer?: string;
    answeredBy?: string;
}
export interface SharedCouncilContext {
    id: string;
    startedAt: number;
    agenda: string;
    mode: CouncilMode;
    rounds: number;
    participants: CouncilParticipant[];
    input: CouncilInput;
    /** Every utterance in order. */
    transcript: TranscriptEntry[];
    findings: Finding[];
    decisions: Decision[];
    actionItems: ActionItem[];
    questions: Question[];
    /** Shared scratchpad all participants can read/write. */
    notes: Record<string, unknown>;
    /** Files/artifacts produced during the meeting. */
    artifacts: Array<{
        id: string;
        kind: string;
        path?: string;
        content?: string;
        producedBy: string;
        at: number;
    }>;
    /** Live snapshot for interpolation: {{council.findings}}, {{council.transcript.last}}, etc. */
    snapshot: Record<string, unknown>;
}
export interface CouncilSpec {
    agenda: string;
    mode?: CouncilMode;
    rounds?: number;
    participants?: CouncilParticipant[];
    /** Use built-in role presets. */
    roles?: string[];
    /** Auto-assemble participants based on agenda if none specified. */
    auto?: boolean;
    input?: CouncilInput;
    /** Chairperson id or role. If omitted a chair is auto-selected/created. */
    chair?: string;
    /** Working directory. */
    cwd?: string;
    /** Stop on first critical error. */
    stopOnError?: boolean;
    /** Per-participant timeout. */
    timeoutMs?: number;
}
export interface CouncilTurnResult {
    participantId: string;
    participantName: string;
    participantRole: string;
    ok: boolean;
    durationMs: number;
    contribution?: Partial<TranscriptEntry>;
    findings?: Partial<Finding>[];
    decisions?: Partial<Decision>[];
    actionItems?: Partial<ActionItem>[];
    questions?: Partial<Question>[];
    notes?: Record<string, unknown>;
    error?: string;
    raw?: unknown;
}
export interface CouncilResult {
    ok: boolean;
    councilId: string;
    durationMs: number;
    mode: CouncilMode;
    rounds: number;
    participants: Array<{
        id: string;
        name: string;
        role: string;
        title?: string;
        chair?: boolean;
    }>;
    agenda: string;
    transcript: TranscriptEntry[];
    findings: Finding[];
    decisions: Decision[];
    actionItems: ActionItem[];
    questions: Question[];
    notes: Record<string, unknown>;
    artifacts: SharedCouncilContext['artifacts'];
    minutes: string;
    summary: string;
    error?: string;
}
//# sourceMappingURL=types.d.ts.map