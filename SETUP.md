# ChatGPT Pilot Setup

Use this prompt with Codex when setting up ChatGPT Pilot on a new machine.

## Codex Setup Prompt

```text
Set up ChatGPT Pilot on this machine and make it fully usable from ChatGPT Web end-to-end.

Repository:
https://github.com/JonusNattapong/chatgpt-pilot

Complete the setup yourself from start to finish:

1. Check and install required prerequisites.
2. Install dependencies, build the project, and run ChatGPT Pilot setup.
3. Configure the ChatGPT Organization/Tunnel Token securely. Never print, log, or commit secrets.
4. Start Pilot and its tunnel.
5. Run `pnpm pilot status` and `pnpm pilot doctor`; diagnose and fix problems until the runtime is healthy.
6. Configure the ChatGPT Web connector/profile to use this Pilot instance.
7. Test from ChatGPT Web itself. Make ChatGPT call at least two real Pilot capabilities, such as `machine_status`, `runtime_info`, or `git_status`.
8. Confirm the responses match the actual state of this machine.

Do not reset, delete, overwrite, stash, or commit existing repository work unless it is required for this setup and explicitly safe. Never expose tokens in source code, Git history, terminal output, or logs.

Definition of done:
Pilot healthy -> Tunnel online -> ChatGPT connected -> real tool calls succeed from ChatGPT Web -> responses are correct.

If anything fails, find and fix the root cause instead of stopping after reporting the error.

When finished, report the final status and the commands for normal operation:
`pnpm pilot start | status | restart | stop`
```

## Normal operation

```bash
pnpm pilot start
pnpm pilot status
pnpm pilot doctor
pnpm pilot restart
pnpm pilot stop
```

For installation details and architecture, see [README.md](README.md).
