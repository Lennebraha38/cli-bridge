import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { listOperations } from '../operations/index.js';
import { Policy } from '../policy.js';
import { registry } from '../registry.js';
import { callTool } from '../runner.js';
import { CouncilContext } from './context.js';
import { autoAssemble, getPreset, resolvePreset } from './presets.js';
import { synthesize } from './synthesizer.js';
function pickTarget(preset, reg) {
    for (const pref of preset.prefer) {
        if (pref.startsWith('op:')) {
            const opId = pref.slice(3);
            if (listOperations().some((op) => op.id === opId))
                return { kind: 'op', target: opId };
        }
        else if (pref.startsWith('tool:')) {
            const toolId = pref.slice(5);
            const tool = reg.get(toolId);
            if (tool && reg.isInstalled(tool))
                return { kind: 'tool', target: toolId };
        }
        else {
            const tool = reg.get(pref);
            if (tool && reg.isInstalled(tool))
                return { kind: 'tool', target: pref };
            if (listOperations().some((op) => op.id === pref))
                return { kind: 'op', target: pref };
        }
    }
    // Fallbacks
    if (reg.get('rg') && reg.isInstalled(reg.get('rg')))
        return { kind: 'tool', target: 'rg' };
    if (reg.get('git') && reg.isInstalled(reg.get('git')))
        return { kind: 'tool', target: 'git' };
    return { kind: 'op', target: 'text.search' };
}
function buildParticipant(spec, preset, reg) {
    const picked = pickTarget(preset, reg);
    return {
        id: `p-${preset.id}-${randomUUID().slice(0, 4)}`,
        name: preset.name,
        role: preset.role,
        title: preset.title,
        kind: picked?.kind === 'op' ? 'op' : 'tool',
        target: picked?.target,
        goal: preset.goal,
        args: preset.prefer.find((p) => p.startsWith('tool:')) ? [] : undefined,
        persona: preset.persona,
        chair: preset.id === 'chair',
    };
}
function classifyContribution(content) {
    const c = content.toLowerCase();
    if (/(decided|decision|agree to|consensus|we should adopt)/.test(c))
        return 'decision-proposal';
    if (/(critical|must fix|blocker|severe)/.test(c))
        return 'concern';
    if (/(action item|todo|assign|follow up|need to)/.test(c))
        return 'action-item';
    if (/(question|how|what if|why not|unclear)/.test(c))
        return 'question';
    if (/(evidence|based on|found|confirmed|verified)/.test(c))
        return 'evidence';
    if (/(suggest|recommend|propose|alternative)/.test(c))
        return 'suggestion';
    if (/(i agree|agreed|correct)/.test(c))
        return 'agreement';
    if (/(disagree|however|concerned|not convinced)/.test(c))
        return 'disagreement';
    if (/(analysis|because|therefore|pattern)/.test(c))
        return 'analysis';
    return 'observation';
}
function extractFindings(content, participant, round) {
    const findings = [];
    const lines = content.split('\n').filter((l) => l.trim());
    for (const line of lines) {
        const t = line.trim();
        if (/^(-|\*|\d+\.)\s+/.test(t) && /(issue|bug|risk|vuln|problem|weakness|concern|bottleneck)/i.test(t)) {
            const severity = /(critical|blocker)/i.test(t) ? 'critical' : /(high|severe)/i.test(t) ? 'high' : /(medium)/i.test(t) ? 'medium' : /(low)/i.test(t) ? 'low' : 'info';
            findings.push({
                raisedBy: participant.name,
                raisedByRole: participant.role,
                severity,
                category: participant.role,
                title: t.replace(/^(-|\*|\d+\.)\s+/, '').slice(0, 120),
                detail: t.replace(/^(-|\*|\d+\.)\s+/, ''),
            });
        }
    }
    if (findings.length === 0 && /(critical|high risk|vulnerability)/i.test(content)) {
        findings.push({
            raisedBy: participant.name,
            raisedByRole: participant.role,
            severity: 'medium',
            category: participant.role,
            title: 'Notable concern raised during discussion',
            detail: content.slice(0, 400),
        });
    }
    return findings;
}
function extractActions(content, participant) {
    const actions = [];
    const lines = content.split('\n').filter((l) => l.trim());
    for (const line of lines) {
        const t = line.trim();
        if (/(action|todo|need to|should do|follow[- ]up)/i.test(t) && /^(-|\*|\d+\.)\s+/.test(t)) {
            const priority = /(urgent|asap|immediately)/i.test(t) ? 'urgent' : /(high)/i.test(t) ? 'high' : 'medium';
            actions.push({
                assignee: t.match(/@([^\s]+)/)?.[1],
                title: t.replace(/^(-|\*|\d+\.)\s+/, '').slice(0, 100),
                detail: t.replace(/^(-|\*|\d+\.)\s+/, ''),
                priority,
            });
        }
    }
    return actions;
}
function extractDecisions(content, participant) {
    const decisions = [];
    if (/(decided|agreed|consensus|adopt|approve)/i.test(content)) {
        const sentences = content.split(/[.!?]\s+/).filter((s) => /(decided|agreed|consensus|adopt|approve)/i.test(s));
        for (const s of sentences.slice(0, 2)) {
            decisions.push({
                proposedBy: participant.name,
                agreedBy: [participant.name],
                title: s.trim().slice(0, 100),
                rationale: content.slice(0, 200),
            });
        }
    }
    return decisions;
}
function extractQuestions(content, participant) {
    const questions = [];
    const matches = content.match(/[^.!?\n]+\?/g);
    if (matches) {
        for (const q of matches.slice(0, 3)) {
            questions.push({ askedBy: participant.name, question: q.trim() });
        }
    }
    return questions;
}
function gatherFiles(cwd, files) {
    if (!files || files.length === 0)
        return '';
    const parts = ['## Provided Files'];
    for (const f of files) {
        try {
            const content = readFileSync(f, 'utf8');
            parts.push(`### ${f}\n\`\`\`\n${content.slice(0, 4000)}\n\`\`\``);
        }
        catch (e) {
            parts.push(`### ${f}\n*(could not read: ${e instanceof Error ? e.message : e})*`);
        }
    }
    return parts.join('\n\n');
}
function buildTurnPrompt(participant, ctx, round) {
    const c = ctx.getContext();
    const recent = c.transcript.slice(-8).map((t) => `- **${t.participantName}** (${t.participantRole}): ${t.content.slice(0, 200)}`).join('\n');
    const findings = c.findings.slice(-6).map((f) => `- [${f.severity ?? 'info'}] ${f.title} (${f.raisedByRole})`).join('\n');
    const actions = c.actionItems.slice(-4).map((a) => `- ${a.title}${a.assignee ? ` @${a.assignee}` : ''}`).join('\n');
    const notes = Object.entries(c.notes).slice(0, 6).map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v).slice(0, 80)}`).join('\n');
    return `# COUNCIL MEETING - Turn
**Council ID:** ${c.id}  
**Round:** ${round} / ${c.rounds}  
**Mode:** ${c.mode}  
**Agenda:** ${c.agenda}  

## Your Role
**Name:** ${participant.name}  
**Title:** ${participant.title ?? participant.role}  
**Role:** ${participant.role}  
**Persona:** ${participant.persona ?? 'Collaborative and evidence-driven.'}  
**Your Goal:** ${participant.goal}

## Shared Context (visible to everyone)
**Input Context:** ${JSON.stringify(c.input.context ?? {})}  
**Constraints:** ${(c.input.constraints ?? []).join(', ') || 'none'}  

### Recent Discussion (last 8 turns)
${recent || '- (no one has spoken yet - you may open this round)'}

### Current Findings
${findings || '- (none yet)'}

### Current Action Items
${actions || '- (none yet)'}

### Shared Notes
${notes || '- (none yet)'}

### Files
${gatherFiles(process.cwd(), c.input.files) || '- (none provided)'}

## Instructions
You are attending a meeting with other CLI tools/participants. Speak as if you're in a conference room.
- Contribute meaningfully based on your role and goal.
- Back up claims with evidence (file names, patterns, logic).
- Build on others' points or respectfully challenge them.
- If you spot issues, call them out with severity.
- Suggest concrete action items when appropriate.
- If you think a decision should be made, propose it clearly.
- Ask questions if something is unclear.
- Keep your response focused and actionable.
- Do NOT just repeat what others said - add new value.
- Structure: state your view, evidence, recommendation.

Respond with your full contribution to this meeting.`;
}
async function invokeParticipant(participant, prompt, policy, timeoutMs) {
    if (participant.kind === 'op' && participant.target) {
        try {
            const { runOperation } = await import('../operations/runner.js');
            // For ops, pass the prompt as context
            const result = await runOperation(participant.target, {
                input: { ...(participant.with ?? {}), query: prompt.slice(0, 2000), context: prompt.slice(0, 4000) },
                timeoutMs,
            });
            const output = typeof result.output === 'string' ? result.output : result.result.stdout || JSON.stringify(result.output, null, 2);
            return { ok: result.ok, output, error: result.error, raw: result };
        }
        catch (error) {
            return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) };
        }
    }
    if (participant.kind === 'tool' && participant.target) {
        try {
            // For search tools, use a query derived from agenda
            let args = participant.args ?? [];
            if (participant.target === 'rg' && args.length === 0) {
                // Extract key terms for search
                args = ['-n', '--max-count', '30', '-C', '2', '\\b(class|function|interface|export|import|TODO|FIXME)\\b', '.'];
            }
            else if (participant.target === 'git' && args.length === 0) {
                args = ['log', '--oneline', '-10'];
            }
            const result = await callTool({ tool: participant.target, args, cwd: process.cwd(), timeoutMs }, policy);
            return { ok: result.ok, output: result.stdout || result.stderr, error: result.error, raw: result };
        }
        catch (error) {
            return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) };
        }
    }
    return { ok: false, output: '', error: 'participant has no valid target' };
}
function formatTurnOutput(participant, round, output) {
    // Make the output more conversational/meeting-like
    if (!output.trim())
        return `${participant.name}: *[silent - no contribution]*`;
    // If output is raw JSON/tool output, wrap it in meeting style
    if (output.trim().startsWith('{') || output.trim().startsWith('[')) {
        return `${participant.name} (${participant.role}):\nI ran a quick check and here's what I found:\n\n${output.slice(0, 1500)}\n\nBased on this, I think we should keep this in mind for the discussion.`;
    }
    // If it looks like grep/git output, summarize style
    if (output.includes(':') && output.split('\n').length > 3) {
        const lines = output.split('\n').filter(Boolean).slice(0, 20);
        return `${participant.name} (${participant.role}):\nLooking through the codebase, I found:\n\n${lines.map(l => `  • ${l}`).join('\n')}\n\n${lines.length >= 20 ? '\n  *(...truncated - more results available)*' : ''}\n\nThis gives us some concrete points to work with.`;
    }
    return `${participant.name} (${participant.role}):\n${output}`;
}
export async function runCouncil(spec) {
    await registry.load({ includeSystem: true });
    const config = loadConfig();
    const policy = new Policy(config.policy);
    const mode = spec.mode ?? 'parallel';
    const rounds = Math.max(1, Math.min(5, spec.rounds ?? 3));
    const timeoutMs = spec.timeoutMs ?? config.exec.timeoutMs;
    // Assemble participants
    let participants = [];
    if (spec.participants && spec.participants.length > 0) {
        participants = spec.participants;
    }
    else if (spec.roles && spec.roles.length > 0) {
        for (const role of spec.roles) {
            const preset = role === 'auto' ? null : (getPreset(role) ?? resolvePreset(role));
            if (role === 'auto') {
                participants.push(...autoAssemble(spec.agenda).map((p) => buildParticipant(spec, p, registry)));
            }
            else if (preset) {
                participants.push(buildParticipant(spec, preset, registry));
            }
        }
    }
    else if (spec.auto !== false) {
        participants.push(...autoAssemble(spec.agenda).map((p) => buildParticipant(spec, p, registry)));
    }
    // Ensure chair exists
    if (!participants.some((p) => p.chair)) {
        const chairPreset = resolvePreset('chair');
        const chair = buildParticipant(spec, chairPreset, registry);
        chair.chair = true;
        chair.order = 0;
        participants.unshift(chair);
    }
    // Sort by order
    participants.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    const councilInput = spec.input ?? { agenda: spec.agenda, context: {}, constraints: [] };
    if (councilInput.agenda !== spec.agenda)
        councilInput.agenda = spec.agenda;
    const ctx = new CouncilContext({
        agenda: spec.agenda,
        mode,
        rounds,
        participants,
        councilInput,
    });
    const councilCtx = ctx.getContext();
    // Run rounds
    for (let round = 1; round <= rounds; round++) {
        if (mode === 'sequential') {
            for (const participant of participants) {
                const prompt = buildTurnPrompt(participant, ctx, round);
                const invoked = await invokeParticipant(participant, prompt, policy, participant.timeoutMs ?? timeoutMs);
                const content = formatTurnOutput(participant, round, invoked.output);
                const entry = {
                    id: `t-${randomUUID().slice(0, 8)}`,
                    at: Date.now(),
                    round,
                    participantId: participant.id,
                    participantName: participant.name,
                    participantRole: participant.role,
                    participantTitle: participant.title,
                    type: classifyContribution(content),
                    content,
                    raw: invoked.raw,
                };
                councilCtx.transcript.push(entry);
                // Extract structured data
                for (const f of extractFindings(content, participant, round)) {
                    { }
                }
                for (const d of extractDecisions(content, participant)) {
                    const existing = councilCtx.decisions.find((x) => x.title === d.title);
                    if (existing) {
                        if (!existing.agreedBy.includes(participant.name))
                            existing.agreedBy.push(participant.name);
                    }
                    else {
                        { }
                    }
                }
                for (const a of extractActions(content, participant)) {
                    { }
                }
                for (const q of extractQuestions(content, participant)) {
                    { }
                }
                ctx.refreshSnapshot();
            }
        }
        else if (mode === 'parallel') {
            const turnPromises = participants.map(async (participant) => {
                const prompt = buildTurnPrompt(participant, ctx, round);
                const invoked = await invokeParticipant(participant, prompt, policy, participant.timeoutMs ?? timeoutMs);
                const content = formatTurnOutput(participant, round, invoked.output);
                return { participant, content, raw: invoked.raw, ok: invoked.ok };
            });
            const turns = await Promise.allSettled(turnPromises);
            for (const turn of turns) {
                if (turn.status === 'fulfilled') {
                    const { participant, content, raw } = turn.value;
                    const entry = {
                        id: `t-${randomUUID().slice(0, 8)}`,
                        at: Date.now(),
                        round,
                        participantId: participant.id,
                        participantName: participant.name,
                        participantRole: participant.role,
                        participantTitle: participant.title,
                        type: classifyContribution(content),
                        content,
                        raw,
                    };
                    councilCtx.transcript.push(entry);
                    for (const f of extractFindings(content, participant, round)) {
                        { }
                    }
                    for (const d of extractDecisions(content, participant)) {
                        const existing = councilCtx.decisions.find((x) => x.title === d.title);
                        if (existing) {
                            if (!existing.agreedBy.includes(participant.name))
                                existing.agreedBy.push(participant.name);
                        }
                        else {
                            { }
                        }
                    }
                    for (const a of extractActions(content, participant)) {
                        { }
                    }
                    for (const q of extractQuestions(content, participant)) {
                        { }
                    }
                }
            }
            ctx.refreshSnapshot();
        }
        else if (mode === 'debate') {
            // Chair speaks first, then others respond
            const chair = participants.find((p) => p.chair) ?? participants[0];
            const others = participants.filter((p) => p !== chair);
            // Chair opens
            const chairPrompt = buildTurnPrompt(chair, ctx, round);
            const chairInvoked = await invokeParticipant(chair, chairPrompt + '\n\nAs chair, open this round by framing the discussion and posing questions to the group.', policy, chair.timeoutMs ?? timeoutMs);
            const chairContent = formatTurnOutput(chair, round, chairInvoked.output);
            councilCtx.transcript.push({ id: `t-${randomUUID().slice(0, 8)}`, at: Date.now(), round, participantId: chair.id, participantName: chair.name, participantRole: chair.role, participantTitle: chair.title, type: 'analysis', content: chairContent, raw: chairInvoked.raw });
            ctx.refreshSnapshot();
            // Others debate
            const turnPromises = others.map(async (participant) => {
                const prompt = buildTurnPrompt(participant, ctx, round);
                const invoked = await invokeParticipant(participant, prompt + '\n\nRespond to the chair and build on or challenge the discussion.', policy, participant.timeoutMs ?? timeoutMs);
                const content = formatTurnOutput(participant, round, invoked.output);
                return { participant, content, raw: invoked.raw };
            });
            const turns = await Promise.allSettled(turnPromises);
            for (const turn of turns) {
                if (turn.status === 'fulfilled') {
                    const { participant, content, raw } = turn.value;
                    councilCtx.transcript.push({ id: `t-${randomUUID().slice(0, 8)}`, at: Date.now(), round, participantId: participant.id, participantName: participant.name, participantRole: participant.role, participantTitle: participant.title, type: classifyContribution(content), content, raw });
                    for (const f of extractFindings(content, participant, round)) { }
                    for (const d of extractDecisions(content, participant)) {
                        const existing = councilCtx.decisions.find((x) => x.title === d.title);
                        if (existing) {
                            if (!existing.agreedBy.includes(participant.name))
                                existing.agreedBy.push(participant.name);
                        }
                        else { }
                    }
                    for (const a of extractActions(content, participant)) { }
                    for (const q of extractQuestions(content, participant)) { }
                }
            }
            ctx.refreshSnapshot();
        }
        else if (mode === 'brainstorm') {
            // All participants throw ideas in parallel
            const turnPromises = participants.map(async (participant) => {
                const prompt = buildTurnPrompt(participant, ctx, round);
                const invoked = await invokeParticipant(participant, prompt + '\n\nBRAINSTORM MODE: Generate creative ideas, wild suggestions, and unconventional approaches. Quantity over perfection - build on possibilities.', policy, participant.timeoutMs ?? timeoutMs);
                const content = formatTurnOutput(participant, round, invoked.output);
                return { participant, content, raw: invoked.raw };
            });
            const turns = await Promise.allSettled(turnPromises);
            for (const turn of turns) {
                if (turn.status === 'fulfilled') {
                    const { participant, content, raw } = turn.value;
                    councilCtx.transcript.push({ id: `t-${randomUUID().slice(0, 8)}`, at: Date.now(), round, participantId: participant.id, participantName: participant.name, participantRole: participant.role, participantTitle: participant.title, type: 'suggestion', content, raw });
                    for (const a of extractActions(content, participant)) { }
                    for (const f of extractFindings(content, participant, round)) {
                        if (f.title) { }
                    }
                }
            }
            ctx.refreshSnapshot();
        }
    }
    // Chair gives closing remarks
    const chair = participants.find((p) => p.chair);
    if (chair) {
        const closingPrompt = `# COUNCIL CLOSING
**Agenda:** ${councilCtx.agenda}
**Findings:** ${councilCtx.findings.length}
**Decisions:** ${councilCtx.decisions.length}
**Action Items:** ${councilCtx.actionItems.length}

As chair, give closing remarks: summarize key takeaways, highlight critical actions, and officially close the meeting.`;
        try {
            const invoked = await invokeParticipant(chair, closingPrompt, policy, timeoutMs);
            const content = formatTurnOutput(chair, rounds + 1, invoked.output);
            councilCtx.transcript.push({ id: `t-${randomUUID().slice(0, 8)}`, at: Date.now(), round: rounds + 1, participantId: chair.id, participantName: chair.name, participantRole: chair.role, participantTitle: chair.title, type: 'analysis', content, raw: invoked.raw });
            ctx.refreshSnapshot();
        }
        catch { }
    }
    return synthesize(councilCtx);
}
export { CouncilContext } from './context.js';
export { synthesize } from './synthesizer.js';
export { ROLE_PRESETS, autoAssemble, getPreset } from './presets.js';
//# sourceMappingURL=runner.js.map