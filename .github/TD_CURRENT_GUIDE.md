# td current - Current Work Management Guide

**Last Updated:** 2026-02-10
**Migration:** Now using global `td` command (marcus/td) instead of local `./scripts/td`

> **Note:** This project has migrated from a local custom td script to the global [marcus/td](https://github.com/marcus/td) CLI tool designed for AI-assisted development with structured handoffs and session isolation.

## Quick Start

```bash
# See what you should be working on RIGHT NOW
td current
```

## What is "Current Work"?

**Current work** = tasks with status `in-progress`

These are the tasks actively being worked on. The `td current` command filters to show only these tasks in a focused view.

## How to Assign Current Work

### Start Working on a Task

```bash
# Assign a task as current work
td update <task-id> --status in-progress --notes "Starting work on this"

# Example
td update 6 --status in-progress --notes "Beginning microservice migration"

# Verify it worked
td current
```

### Complete Current Work

```bash
# Mark task complete
td update <task-id> --status complete --notes "Finished successfully"

# Verify it's removed from current work
td current
```

### Switch Tasks (Pivot)

```bash
# Put old task back to todo
td update <old-id> --status todo

# Start new task
td update <new-id> --status in-progress --notes "Pivoting to this task"

# Verify
td current
```

## Best Practices

### ✅ DO
- Keep only **1-2 tasks** in-progress at once
- Always run `td current` before starting work
- Update notes regularly as you make progress
- Move completed tasks to 'complete' status promptly
- Use `td current` to answer "what should I work on?"

### ❌ DON'T
- Have more than 2-3 tasks in-progress (loses focus)
- Leave tasks in-progress when you stop working on them
- Forget to check `td current` before starting new work
- Skip verification after assigning current work

## Common Commands

```bash
# Show current work (primary command)
td current

# Show all in-progress tasks with more detail
td list --status in-progress

# Show details of a specific task
td show <task-id>

# Add notes to current work
td update <task-id> --notes "Progress update"

# Check overall project status
td status

# See all available tasks
td list

# See only todo tasks (candidates for next work)
td list --status todo
```

## Example Workflow

### Morning Startup
```bash
# 1. Check what you should be working on
td current

# 2. If nothing is in-progress, check todos
td list --status todo

# 3. Pick highest priority and assign
td update 7 --status in-progress --notes "Starting deployment prep"

# 4. Verify
td current
```

### During Work
```bash
# Update progress periodically
td update 7 --notes "Completed step 1 of 3"

# Check overall status
td status
```

### When Task is Done
```bash
# 1. Mark complete
td update 7 --status complete --notes "Successfully deployed"

# 2. Verify it's removed
td current

# 3. Check what's next
td list --status todo
```

### When Blocked
```bash
# Mark as blocked
td update 7 --status blocked --blocker "Waiting for microservice deployment"

# Find something else to work on
td list --status todo
td update 8 --status in-progress
```

## For Project Orchestrator Agent

The project-orchestrator agent has been configured to:

1. **Always start with `td current`** when consulted
2. **Assign recommended work** by updating status to in-progress
3. **Verify assignments** by running `td current` after updates
4. **Maintain focus** by keeping only 1-2 tasks in-progress
5. **Update completed tasks** before recommending new work

### Agent Commands
```bash
# Agent checks current work
td current

# Agent assigns new current work
td update <id> --status in-progress --notes "Assigned by orchestrator: [reason]"

# Agent verifies assignment
td current

# Agent checks project health
td status
```

## Troubleshooting

### "No tasks currently in progress"
This means nothing is assigned as current work. Either:
- Start work on a todo task: `td update <id> --status in-progress`
- Or consult project-orchestrator: Ask "what should I work on?"

### Too many tasks in progress
If `td current` shows 3+ tasks:
- Review each task: `td show <id>`
- Complete finished ones: `td update <id> --status complete`
- Move paused ones back to todo: `td update <id> --status todo`
- Keep only 1-2 active for focus

### Task not showing in td current
Check the task status: `td show <id>`
- If status is not `in-progress`, it won't show
- Assign it: `td update <id> --status in-progress`

## Reference

**Command:** `td current`  
**Purpose:** Show current work (in-progress tasks)
**Added:** 2026-02-09
**Type:** Global CLI tool (marcus/td)
**Related:** `.github/CURRENT_WORK.md`, `.github/agents/project-orchestrator.agent.md`

---

For more information, see:
- [CURRENT_WORK.md](.github/CURRENT_WORK.md) - Current project priorities
- [project-orchestrator.agent.md](.github/agents/project-orchestrator.agent.md) - Agent configuration
