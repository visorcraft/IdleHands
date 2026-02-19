# MEMORY.md — Long-Term Memory Approaches for Idle Hands

> Three viable approaches to persistent memory for a local-first coding agent. Each has different tradeoffs on token cost, infrastructure complexity, and recall quality. All are designed to work **without cloud services** and with **local LLMs only**.

---

## The Problem

Idle Hands sessions start cold. Every time. The model has no memory of:
- What files it edited yesterday
- What patterns it learned about this codebase
- What build commands worked (or didn't)
- What decisions were made and why
- What the user prefers (edit style, test framework, deploy targets)

Project context bootstrapping (AGENTS.md, §9b in PLAN.md) helps with static project knowledge, but it can't capture session-level learning. A 10-session history of working on a codebase builds intuition that's lost every time.

### Constraints specific to Idle Hands
- **No external databases.** No Postgres, no Redis, no ChromaDB running as a service. Single-user CLI tool.
- **No cloud APIs for memory.** Everything runs locally — the LLM, the embeddings, the storage.
- **Token budget is sacred.** Memory injection must be small enough to not blow the context window. At 128K context with a 200-token system prompt, we have room — but not infinite room.
- **Must work with dumb models.** The memory system can't rely on the LLM being smart enough to "manage its own memory." The system manages memory; the LLM consumes it.
- **Portable.** Memory should be a file (or directory) you can copy, version, or delete.

---

## Approach 1: Append-Only Session Log + Local Embedding Search

**Inspiration:** OpenClaw's `memory/*.md` files + memvid's single-file approach + classic RAG.

### How it works

Every session produces an append-only **session log** — a structured JSONL file capturing what happened:

```jsonl
{"ts":"2026-02-14T19:30:00Z","type":"instruction","text":"fix the broken import in api.py"}
{"ts":"2026-02-14T19:30:05Z","type":"tool","name":"read_file","args":{"path":"api.py","search":"import"},"result_summary":"42 lines, found 'from flask import' at line 3"}
{"ts":"2026-02-14T19:30:12Z","type":"tool","name":"edit_file","args":{"path":"api.py"},"result":"replaced 'from flask import Flask' with 'from flask import Flask, jsonify'"}
{"ts":"2026-02-14T19:30:15Z","type":"tool","name":"exec","args":{"command":"python -c 'import api'"},"result":"exit 0, no output"}
{"ts":"2026-02-14T19:30:16Z","type":"outcome","text":"Fixed missing jsonify import in api.py. Verified with import check."}
```

Session logs are stored per-project: `.idlehands/sessions/{date}-{hash}.jsonl`

On session start, the system:
1. **Embeds the current instruction** using a small local embedding model
2. **Searches past session logs** for semantically similar entries
3. **Injects the top-K most relevant entries** into the first user message as context

### Embedding model

Use a small, fast, local embedding model. Options:
- **gte-small** (33M params, ~130MB) — good quality, runs on CPU in <10ms per embedding
- **all-MiniLM-L6-v2** (22M params, ~90MB) — lighter, slightly lower quality
- **nomic-embed-text-v1.5** (137M params, GGUF available) — best quality, runs via llama-server

The embedding model runs as a **separate process** (or uses llama-server's `/v1/embeddings` endpoint if available). It does NOT share the main LLM's GPU time.

### Storage format

**Single SQLite file** per project: `.idlehands/memory.db`

```sql
-- Raw session entries
CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  timestamp TEXT,
  type TEXT,          -- instruction, tool, outcome, decision, error
  content TEXT,       -- the actual text
  file_path TEXT,     -- associated file (if any)
  embedding BLOB      -- float32 vector
);

-- Precomputed "lessons" extracted after each session
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY,
  created TEXT,
  content TEXT,       -- "api.py uses Flask, not FastAPI. Import jsonify from flask."
  source_session TEXT,
  embedding BLOB,
  relevance_count INTEGER DEFAULT 0  -- how often this was retrieved
);

CREATE VIRTUAL TABLE entries_fts USING fts5(content, file_path);
```

### Retrieval at session start

```
1. Embed user's first instruction
2. Vector search: top 10 entries by cosine similarity from entries table
3. FTS search: keyword match on file paths and terms from instruction
4. Merge + deduplicate results
5. Format as context block (max 2048 tokens):

[Memory: 5 relevant past interactions]
- 2026-02-14: Fixed missing jsonify import in api.py (flask, not fastapi)
- 2026-02-13: api.py tests: run with `pytest tests/test_api.py -v`
- 2026-02-12: Build command: `docker build -t myapp .` (Dockerfile in repo root)
[End memory]
```

### Post-session lesson extraction

After each session ends, run a **batch extraction** (can be async/background):
1. Feed the session log to the LLM: "Summarize what was learned in this session as a list of facts."
2. Each fact becomes a `lesson` entry with its own embedding
3. Lessons accumulate across sessions and are the primary retrieval target (higher signal-to-noise than raw entries)

**Cost:** One LLM call per session (not per turn). At session end, not blocking the user.

### Strengths
- Simple to implement (SQLite + embeddings, both well-understood)
- Portable (one .db file per project)
- Scales gracefully (SQLite handles millions of rows)
- Lesson extraction concentrates signal over time
- FTS + vector hybrid catches both exact terms and semantic similarity

### Weaknesses
- Requires a local embedding model (additional dependency, ~100-150MB)
- Lesson extraction quality depends on the LLM
- Cold start: first session has no memory, no matter what
- Vector search quality degrades if embedding model is too small

### Token cost per session
- Injection: ~500-2048 tokens at session start (configurable cap)
- Extraction: one LLM call at session end (~2K input, ~500 output)

---

## Approach 2: Structured Knowledge Graph (Entity-Relation-Fact)

**Inspiration:** Memlayer's hybrid vector+graph approach + Memobase's user profiling + classic knowledge graphs.

### How it works

Instead of storing raw session logs and searching them, **extract structured knowledge** after every session and maintain a **project knowledge graph** that grows over time.

The graph has three node types:
- **Entities**: files, functions, classes, commands, tools, config values
- **Relations**: `imports`, `calls`, `depends_on`, `built_by`, `tested_by`, `deployed_via`
- **Facts**: freeform observations attached to entities or relations

```
[api.py] --imports--> [flask.Flask]
[api.py] --imports--> [flask.jsonify]
[api.py] --tested_by--> [pytest tests/test_api.py]
[api.py] --fact--> "Uses Flask, not FastAPI. User corrected this on 2026-02-14."
[project] --built_by--> [docker build -t myapp .]
[project] --deployed_via--> [kubectl apply -f k8s/]
[project] --fact--> "User prefers running tests before committing."
```

### Storage format

**Single JSON file** per project: `.idlehands/knowledge.json`

```json
{
  "entities": {
    "file:api.py": {
      "type": "file",
      "last_seen": "2026-02-14T19:30:00Z",
      "facts": [
        {"text": "Uses Flask, not FastAPI", "added": "2026-02-14", "confidence": 0.9},
        {"text": "Has 3 endpoints: /health, /users, /items", "added": "2026-02-13", "confidence": 0.8}
      ]
    },
    "cmd:pytest tests/test_api.py": {
      "type": "command",
      "last_seen": "2026-02-14T19:30:15Z",
      "facts": [
        {"text": "Runs API tests, takes ~3s", "added": "2026-02-14", "confidence": 0.7}
      ]
    }
  },
  "relations": [
    {"from": "file:api.py", "rel": "tested_by", "to": "cmd:pytest tests/test_api.py"},
    {"from": "file:api.py", "rel": "imports", "to": "pkg:flask"}
  ],
  "preferences": {
    "test_before_commit": true,
    "edit_style": "minimal_surgical",
    "preferred_test_runner": "pytest"
  },
  "meta": {
    "sessions_processed": 47,
    "last_updated": "2026-02-14T19:35:00Z"
  }
}
```

### Knowledge extraction (post-session)

After each session, one LLM call with a structured extraction prompt:

```
Given this session log, extract:
1. ENTITIES: files, functions, commands, packages mentioned
2. RELATIONS: how entities relate (imports, tests, builds, deploys)
3. FACTS: observations about entities (what they do, gotchas, preferences)
4. PREFERENCES: user behavior patterns (test before commit, edit style, etc.)

Output as JSON matching the schema.
```

The extracted knowledge is **merged** into the existing graph:
- New entities are added
- Existing entities get updated `last_seen` and new facts
- Duplicate facts are deduplicated by text similarity
- Old facts with low confidence decay over time (halve confidence after 30 days of not being reinforced)

### Retrieval at session start

No embedding search needed. Graph traversal based on the user's instruction:

1. **Parse the instruction** for file names, function names, commands
2. **Look up matching entities** in the graph
3. **Traverse 1-hop relations** to find related entities
4. **Collect facts** from matched entities + neighbors
5. **Include preferences** always

```
[Project knowledge]
- api.py: Flask app (not FastAPI), 3 endpoints (/health, /users, /items)
- api.py imports: flask, flask.jsonify
- api.py tested by: pytest tests/test_api.py (~3s)
- Build: docker build -t myapp .
- User preference: test before commit, minimal edits
[End project knowledge]
```

### Fact decay and contradiction resolution

Facts aren't permanent. They have a `confidence` score that:
- **Increases** when a fact is confirmed (model reads the file and the fact is still true)
- **Decreases** when a fact is contradicted (model reads the file and it's changed)
- **Decays** over time (halve after 30 days of no reinforcement)
- Facts below confidence 0.3 are pruned on next extraction pass

Contradiction handling: if a new fact directly contradicts an existing one (same entity, same property, different value), the new fact replaces the old one. The old fact is moved to a `history` array for debugging.

### Strengths
- **Zero-latency retrieval** — JSON parse + key lookup, no embedding search
- **No embedding model needed** — eliminates a dependency entirely
- **Highly structured** — the model gets clean, organized context instead of raw log snippets
- **Preferences are first-class** — the system learns HOW the user works, not just WHAT they worked on
- **Fact decay prevents stale knowledge** — the graph self-maintains

### Weaknesses
- **Extraction quality depends on the LLM** — same as Approach 1
- **Brittle entity matching** — "api.py" vs "./api.py" vs "app/api.py" needs normalization
- **Doesn't capture narrative** — "we tried X, it failed, then we tried Y" is lost in structured extraction
- **JSON file grows** — needs periodic compaction (prune low-confidence facts, merge duplicates)
- **No semantic search** — if the user asks about something phrased differently than the stored facts, keyword matching may miss it

### Token cost per session
- Injection: ~300-1500 tokens (depends on number of matched entities)
- Extraction: one LLM call at session end (~3K input, ~1K output, structured JSON)

---

## Approach 3: Tiered Memory with Temporal Decay (Short/Mid/Long)

**Inspiration:** Human memory (sensory→working→long-term) + MemOS's memory lifecycle + memvid's temporal timeline.

### How it works

Memory is organized in **three tiers** that mirror how humans remember things:

#### Tier 1: Working Memory (this session)
- The current conversation history
- Already handled by the agent loop's history management
- Evicted completely when session ends
- **Cost: 0 additional tokens** (it's the conversation itself)

#### Tier 2: Recent Memory (last 7 days)
- Complete session transcripts stored as compressed JSONL
- Searched on demand via a `memory_search` tool the model can call
- NOT auto-injected — the model decides when it needs memory
- **Cost: 0 tokens unless the model asks** (tool call + results when used)

#### Tier 3: Crystallized Memory (permanent)
- Distilled facts, patterns, and preferences extracted from Tier 2
- Auto-injected at session start (like Approach 2's knowledge graph)
- Small, high-signal, slow-changing
- **Cost: ~500-1000 tokens at session start**

### The key insight: the MODEL controls recall

Unlike Approaches 1 and 2, which auto-inject memory at session start, Approach 3 gives the model a **memory tool** and lets it decide when to search:

```json
{
  "name": "memory_search",
  "description": "Search past session history for relevant context. Use when you need to recall previous work, decisions, or patterns. Returns matching entries from the last 7 days.",
  "parameters": {
    "query": "string — what to search for",
    "max_results": "integer — max results (default 5)"
  }
}
```

This means:
- Simple tasks ("fix this typo") consume **zero memory tokens**
- Complex tasks ("continue the refactor from yesterday") trigger memory search **on demand**
- The model learns when it needs context and when it doesn't

### Storage

```
.idlehands/
├── memory/
│   ├── working/          # Tier 1: current session (ephemeral)
│   ├── recent/           # Tier 2: last 7 days of session logs
│   │   ├── 2026-02-14-a3f2.jsonl.gz
│   │   ├── 2026-02-13-b1c9.jsonl.gz
│   │   └── ...
│   ├── crystal.json      # Tier 3: permanent distilled knowledge
│   └── index.db          # SQLite FTS index over recent/ entries
```

### Tier 2 → Tier 3 crystallization

Runs nightly (or on `idle-hands --crystallize`):

1. Load all Tier 2 sessions from the last 7 days
2. Feed to LLM in batches: "What lasting knowledge should be preserved from these sessions?"
3. Merge extracted facts into `crystal.json` (same structure as Approach 2's knowledge graph)
4. Delete Tier 2 entries older than 7 days (they've been crystallized)

The crystallization prompt is specific:
```
You are reviewing 7 days of coding sessions on a project. Extract:
1. FACTS that will still be true next week (file structures, build commands, API patterns)
2. PREFERENCES the user demonstrated repeatedly (not one-offs)
3. GOTCHAS that caused errors or wasted time
4. DECISIONS and their reasoning (so they're not re-debated)

Do NOT extract: temporary debugging steps, one-time fixes, transient state.
```

### Temporal decay in Tier 2

Recent memory entries have a natural TTL (7 days). This means:
- Yesterday's session is fully searchable with every detail
- Last week's session has been crystallized into key facts
- Last month's session exists only as crystallized knowledge

This mirrors how humans remember: vivid recent detail, fading into general knowledge over time.

### The memory_search tool in practice

```
User: "Continue the auth refactor from Tuesday"

Model thinks: I don't know what auth refactor. Let me search.

Model calls: memory_search(query="auth refactor")

Returns:
  - 2026-02-11: Refactored auth.py to use JWT instead of session cookies.
    Changed: auth.py (middleware), routes/login.py (token generation), config.py (JWT_SECRET)
    Status: middleware done, routes/login.py partially complete (2 of 5 endpoints converted)
    Next: convert /api/users and /api/admin endpoints

Model: I see. Let me pick up where we left off. Let me read the current state of routes/login.py...
```

The model got exactly the context it needed, only when it needed it, at the cost of one tool call (~200ms for FTS search).

### Strengths
- **Token-optimal** — zero memory cost for simple tasks, on-demand for complex tasks
- **Natural temporal decay** — recent detail fades into permanent knowledge automatically
- **Model-driven recall** — the model searches when it needs to, not when we guess it should
- **Hybrid detail levels** — raw transcripts (Tier 2) for recent, distilled facts (Tier 3) for permanent
- **No embedding model for Tier 2** — FTS (keyword search) over recent sessions is good enough for 7 days of data

### Weaknesses
- **Depends on the model being smart enough to use memory_search** — bad models won't call it when they should
- **Crystallization quality depends on the LLM** — same as all approaches
- **One more tool in the tool catalog** — adds ~100 tokens to the tool schema overhead
- **7-day window is arbitrary** — some projects are touched monthly, not daily
- **FTS for Tier 2 may miss semantic matches** — "authentication system" won't match "JWT middleware" without embeddings

### Possible hybrid enhancement
Use embeddings for Tier 3 (crystallized knowledge is small, embedding is cheap) and FTS for Tier 2 (recent sessions are large but keyword search is sufficient for 7 days of data). Best of both worlds, minimal additional overhead.

### Token cost per session
- Auto-injection (Tier 3): ~500-1000 tokens at session start
- On-demand search (Tier 2): ~200-800 tokens per search, only when model calls memory_search
- Crystallization: one LLM call per week (~5-10K input, ~1K output)

---

## Comparison Matrix

| Dimension | Approach 1: Embeddings | Approach 2: Knowledge Graph | Approach 3: Tiered Memory |
|-----------|----------------------|---------------------------|-------------------------|
| **Dependencies** | SQLite + embedding model (~150MB) | SQLite (or just JSON) | SQLite + optional embedding model |
| **Token cost (simple task)** | 500-2048 (always injected) | 300-1500 (always injected) | ~500 (Tier 3 only) |
| **Token cost (complex task)** | 500-2048 (same) | 300-1500 (same) | 500-1800 (Tier 3 + search) |
| **Retrieval quality** | High (semantic search) | Medium (keyword/entity match) | High (hybrid: FTS recent + semantic permanent) |
| **Implementation complexity** | Medium | Medium-High | High |
| **Recall of narrative/decisions** | Good (raw logs preserved) | Poor (structured extraction loses narrative) | Excellent (recent raw + permanent distilled) |
| **Works with dumb models** | Yes (search is external) | Partially (extraction quality varies) | No (model must call memory_search) |
| **Stale knowledge handling** | Poor (no decay) | Good (confidence decay) | Excellent (TTL + crystallization) |
| **Portability** | One .db file | One .json file | Directory with .jsonl.gz + .json + .db |

---

## Recommendation

**Start with Approach 3 (Tiered Memory) but implement it incrementally:**

1. **Phase 1 MVP:** Tier 3 only — a hand-curated `crystal.json` (basically an enhanced AGENTS.md). No auto-extraction yet. Injected at session start. This is free — it's just the project context bootstrap from PLAN.md §9b with a structured format.

2. **Phase 2:** Add Tier 2 — session log recording + FTS index + `memory_search` tool. Now the model can search recent history on demand. No embedding model needed yet.

3. **Phase 3:** Add crystallization — automated Tier 2 → Tier 3 extraction via LLM. Now the system learns permanently without manual curation.

4. **Phase 4 (optional):** Add embeddings to Tier 3 for semantic search over crystallized knowledge. Only worth it if FTS proves insufficient.

This approach:
- Ships something useful immediately (Phase 1 costs nothing)
- Each phase adds measurable value
- The most complex parts (embeddings, auto-extraction) are deferred until the simpler parts prove the concept
- Works with Qwen3-Coder-Next from day one (it's smart enough to use memory_search)
