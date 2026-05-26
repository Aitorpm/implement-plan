# /implement-plan

Generate and execute an implementation plan from a natural language description.

## Steps

1. Run the generator — use the Bash tool to execute:
   ```
   implement-plan generate --save-only "$ARGUMENTS"
   ```
   This generates a YAML plan and saves it to `~/.claude/plans/`. The command prints the saved path on the last line.

2. Read the saved plan file with the Read tool. Show the full contents to the user.

3. Ask the user: "Does this plan look right? Any changes before I execute it?"
   - If they want changes: edit the plan file with the Edit tool, show the updated version, ask again.
   - If they confirm: continue to step 4.

4. Run validation — use the Bash tool:
   ```
   implement-plan validate <path-from-step-1>
   ```
   If there are errors, show them and go back to step 3 (edit mode).

5. Execute — use the Bash tool:
   ```
   implement-plan <path-from-step-1>
   ```
   Stream the output to the user. Report the final result.

---

The generation step (step 1) uses Claude or Codex via the CLI — it handles provider failover independently of this session. The conversation is only used for review (step 3), which is the lightest part of the flow.
