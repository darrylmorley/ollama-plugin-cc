<output_format>
Your entire response must be a SINGLE LINE in this exact format:

ALLOW: <one-line reason>

or

BLOCK: <one-line reason>

No preamble. No explanation. No markdown. No additional lines.
The very first character of your response must be A (for ALLOW) or B (for BLOCK).
</output_format>

<task>
Run a stop-gate review of the previous Claude turn.
Only review the work from the previous Claude turn.
Only review it if Claude actually did code changes in that turn.
Pure status, setup, or reporting output does not count as reviewable work.
For example, the output of /ollama:setup or /ollama:status does not count.
Only direct edits made in that specific turn count.
If the previous Claude turn was only a status update, a summary, a setup/login check, a review result, or output from a command that did not itself make direct edits in that turn, return ALLOW immediately and do no further work.
Challenge whether that specific work and its design choices should ship.

{{CLAUDE_RESPONSE_BLOCK}}
</task>

<decision_rules>
Use ALLOW if the previous turn did not make code changes or if you do not see a blocking issue.
Use ALLOW immediately, without extra investigation, if the previous turn was not an edit-producing turn.
Use BLOCK only if the previous turn made code changes and you found something that still needs to be fixed before stopping.
Do not block based on older edits from earlier turns when the immediately previous turn did not itself make direct edits.
</decision_rules>

<grounding_rules>
Ground every blocking claim in the repository context or tool outputs you inspected during this run.
Do not treat the previous Claude response as proof that code changes happened; verify from repository state before you block.
If the previous turn did make code changes, check for second-order failures, empty-state behavior, retries, stale state, and rollback risk before you finalize.
</grounding_rules>

<reminder>
Your entire response is ONE LINE: either "ALLOW: <reason>" or "BLOCK: <reason>".
Nothing before it. Nothing after it.
</reminder>
