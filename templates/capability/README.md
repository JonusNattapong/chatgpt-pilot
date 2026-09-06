# Capability Template

Use this template when Pilot needs a reusable executable capability that the current surface does not provide. Do not create a capability for a one-off shell command.

## Create

1. Inspect `apps/server/src/tools.ts`, the closest implementation module, and relevant tests.
2. Implement the operation in a focused module when it is more than a trivial adapter.
3. Register a `ToolSpec` with a stable snake_case name, precise description, bounded JSON Schema, accurate MCP annotations, and explicit argument validation.
4. Add tests for success, malformed input, policy/path boundaries, and failure behavior.
5. Bump `CONTRACT_VERSION` when the public capability contract changes.
6. Run strict verification and inspect the diff.
7. Compare the live and fresh capability surfaces with `capability_diff`.
8. Reload with `restart_if_stale` when required, then confirm with `runtime_info`.

## Update

- Preserve backwards compatibility unless a breaking change is intentional.
- Keep schema, validation, annotations, handler behavior, tests, and docs synchronized.
- Treat annotation changes as security-relevant contract changes.
- Bump `CONTRACT_VERSION` for public schema/annotation changes.

## Delete

- Remove registration, implementation that is no longer shared, tests/fixtures, and documentation references.
- Search the repository for the capability name before deleting.
- Bump `CONTRACT_VERSION`, verify, run `capability_diff`, reload, and confirm removal.

## ToolSpec skeleton

```ts
{
  name: 'example_status',
  description: 'Return bounded structured status for ...',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  handler: async (args) => {
    const target = requireString(args, 'path');
    return exampleStatus(target);
  },
}
```

## Definition of done

`implementation -> tests -> contract -> strict verify -> capability_diff -> reload if stale -> runtime_info`
