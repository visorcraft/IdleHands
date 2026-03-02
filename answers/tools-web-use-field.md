# Web Search/Fetch Configuration: `enabled` vs `use`

## Short Answer

The IdleHands config uses `enabled` (not `use`) for the web search and web fetch tools.

## Correct Configuration Fields

### Web Search

```json
{
  "tools": {
    "web": {
      "search": {
        "enabled": true,
        "provider": "brave",
        "apiKey": "...",
        "maxResults": 5
      }
    }
  }
}
```

### Web Fetch

```json
{
  "tools": {
    "web": {
      "fetch": {
        "enabled": true,
        "maxChars": 5000,
        "readability": true
      }
    }
  }
}
```

## Current Config Status

Your current config (`~/.idlehands/idlehands.json`) does not have a `tools` section at all. To enable web search or web fetch, add the appropriate configuration.

## Notes

- `tools.web.search.enabled`: Controls the `web_search` tool (default: `true` when API key is present)
- `tools.web.fetch.enabled`: Controls the `web_fetch` tool (default: `true`)
- The field is `enabled`, not `use`

## References

- Schema definition: `src/config/zod-schema.agent-runtime.ts` (lines ~327-387)
- Tool implementation: `src/agents/tools/web-search.ts` and `src/agents/tools/web-fetch.ts`
- Schema help: `src/config/schema.help.ts` (lines 588-630)
