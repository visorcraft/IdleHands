# Matching src/tools.ts tool implementations (apply_patch via git apply/patch, edit_range, and read_file format/max_bytes support) in the same “exact diff” style are below.

```diff
diff --git a/src/tools.ts b/src/tools.ts
--- a/src/tools.ts
+++ b/src/tools.ts
@@ -342,14 +342,30 @@
 
 export async function read_file(ctx: ToolContext, args: any) {
   const p = resolvePath(ctx, args?.path);
-  const offset = args?.offset ? Number(args.offset) : undefined;
+  const offset = args?.offset != null ? Number(args.offset) : undefined;
+
   const rawLimit = args?.limit != null ? Number(args.limit) : undefined;
   const limit = Number.isFinite(rawLimit as number) && (rawLimit as number) > 0
     ? Math.max(1, Math.floor(rawLimit as number))
-    : undefined;
+    : 200;
+
   const search = typeof args?.search === 'string' ? args.search : undefined;
-  const context = args?.context ? Number(args.context) : 10;
-  const maxBytes = 100 * 1024;
+
+  const rawContext = args?.context != null ? Number(args.context) : undefined;
+  const context = Number.isFinite(rawContext as number) && (rawContext as number) >= 0
+    ? Math.max(0, Math.min(200, Math.floor(rawContext as number)))
+    : 10;
+
+  const formatRaw = typeof args?.format === 'string' ? args.format.trim().toLowerCase() : 'numbered';
+  const format: 'plain' | 'numbered' | 'sparse' =
+    (formatRaw === 'plain' || formatRaw === 'numbered' || formatRaw === 'sparse')
+      ? (formatRaw as 'plain' | 'numbered' | 'sparse')
+      : 'numbered';
+
+  const rawMaxBytes = args?.max_bytes != null ? Number(args.max_bytes) : undefined;
+  const maxBytes = Number.isFinite(rawMaxBytes as number) && (rawMaxBytes as number) > 0
+    ? Math.min(256 * 1024, Math.max(256, Math.floor(rawMaxBytes as number)))
+    : 20 * 1024;
 
   if (!p) throw new Error('read_file: missing path');
 
@@ -367,14 +383,6 @@
     throw new Error(`read_file: cannot read ${p}: ${e?.message ?? String(e)}`);
   });
 
-  if (buf.length > maxBytes) {
-    // Truncate gracefully instead of throwing
-    const truncText = buf.subarray(0, maxBytes).toString('utf8');
-    const truncLines = truncText.split(/\r?\n/);
-    const numbered = truncLines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n');
-    return `# ${p} [TRUNCATED: ${buf.length} bytes, showing first ${maxBytes}]\n${numbered}`;
-  }
-
   // Binary detection: NUL byte in first 512 bytes (§8)
   for (let i = 0; i < Math.min(buf.length, 512); i++) {
     if (buf[i] === 0) {
@@ -387,41 +395,69 @@
   const lines = text.split(/\r?\n/);
 
   let start = 1;
-  let end = limit ? Math.min(lines.length, limit) : lines.length;
+  let end = Math.min(lines.length, limit);
+
+  let matchLines: number[] = [];
 
   if (search) {
-    const matchLines: number[] = [];
+    matchLines = [];
     for (let i = 0; i < lines.length; i++) {
       if (lines[i].includes(search)) matchLines.push(i + 1);
     }
     if (!matchLines.length) {
-      return `# ${p}\n# search not found: ${JSON.stringify(search)}\n# file has ${lines.length} lines`;
+      return truncateBytes(
+        `# ${p}\n# search not found: ${JSON.stringify(search)}\n# file has ${lines.length} lines`,
+        maxBytes
+      ).text;
     }
     const firstIdx = matchLines[0];
+    // Window around the first match, but never return more than `limit` lines.
     start = Math.max(1, firstIdx - context);
     end = Math.min(lines.length, firstIdx + context);
-
-    const out: string[] = [];
-    out.push(`# ${p}`);
-    out.push(`# matches at lines: ${matchLines.join(', ')}${matchLines.length > 20 ? ' [truncated]' : ''}`);
-    for (let ln = start; ln <= end; ln++) {
-      out.push(`${String(ln).padStart(6, ' ')}| ${lines[ln - 1] ?? ''}`);
+    if (end - start + 1 > limit) {
+      const half = Math.floor(limit / 2);
+      start = Math.max(1, firstIdx - half);
+      end = Math.min(lines.length, start + limit - 1);
     }
-    if (end < lines.length) out.push(`# ... (${lines.length - end} more lines)`);
-    return out.join('\n');
   } else if (offset && offset >= 1) {
-    start = offset;
-    end = limit ? Math.min(lines.length, offset + limit - 1) : lines.length;
+    start = Math.max(1, Math.floor(offset));
+    end = Math.min(lines.length, start + limit - 1);
   }
 
+  const matchSet = new Set<number>(matchLines);
+
   const out: string[] = [];
-  out.push(`# ${p}`);
+  out.push(`# ${p} (lines ${start}-${end} of ${lines.length})`);
+
+  if (search) {
+    const shown = matchLines.slice(0, 20);
+    out.push(`# matches at lines: ${shown.join(', ')}${matchLines.length > shown.length ? ' …' : ''}`);
+  }
+
+  const renderNumbered = (ln: number, body: string) => `${ln}| ${body}`;
+
   for (let ln = start; ln <= end; ln++) {
-    out.push(`${String(ln).padStart(6, ' ')}| ${lines[ln - 1] ?? ''}`);
+    const body = lines[ln - 1] ?? '';
+
+    if (format === 'plain') {
+      out.push(body);
+      continue;
+    }
+
+    if (format === 'numbered') {
+      out.push(renderNumbered(ln, body));
+      continue;
+    }
+
+    // sparse: number anchor lines + matches; otherwise raw text.
+    const isAnchor = ln === start || ln === end || (ln - start) % 10 === 0;
+    if (isAnchor || matchSet.has(ln)) out.push(renderNumbered(ln, body));
+    else out.push(body);
   }
+
   if (end < lines.length) out.push(`# ... (${lines.length - end} more lines)`);
 
-  return out.join('\n');
+  return truncateBytes(out.join('\n'), maxBytes).text;
 }
 
 export async function read_files(ctx: ToolContext, args: any) {
@@ -588,6 +624,341 @@
   return `inserted into ${p} at ${idx}${replayNote}${cwdWarning}`;
 }
 
+type PatchTouchInfo = {
+  paths: string[]; // normalized relative paths
+  created: Set<string>;
+  deleted: Set<string>;
+};
+
+function normalizePatchPath(p: string): string {
+  let s = String(p ?? '').trim();
+  if (!s || s === '/dev/null') return '';
+
+  // Strip quotes some generators add
+  s = s.replace(/^"|"$/g, '');
+  // Drop common diff prefixes
+  s = s.replace(/^[ab]\//, '').replace(/^\.\/+/, '');
+  // Normalize to posix separators for diffs
+  s = s.replace(/\\/g, '/');
+
+  const norm = path.posix.normalize(s);
+  if (norm.startsWith('../') || norm === '..' || norm.startsWith('/')) {
+    throw new Error(`apply_patch: unsafe path in patch: ${JSON.stringify(s)}`);
+  }
+  return norm;
+}
+
+function extractTouchedFilesFromPatch(patchText: string): PatchTouchInfo {
+  const paths: string[] = [];
+  const created = new Set<string>();
+  const deleted = new Set<string>();
+
+  let pendingOld: string | null = null;
+  let pendingNew: string | null = null;
+
+  const seen = new Set<string>();
+  const lines = String(patchText ?? '').split(/\r?\n/);
+
+  for (const line of lines) {
+    // Primary: git-style header
+    if (line.startsWith('diff --git ')) {
+      const m = /^diff --git\s+a\/(.+?)\s+b\/(.+?)\s*$/.exec(line);
+      if (m) {
+        const aPath = normalizePatchPath(m[1]);
+        const bPath = normalizePatchPath(m[2]);
+        const use = bPath || aPath;
+        if (use && !seen.has(use)) {
+          seen.add(use);
+          paths.push(use);
+        }
+      }
+      pendingOld = null;
+      pendingNew = null;
+      continue;
+    }
+
+    // Fallback: unified diff headers
+    if (line.startsWith('--- ')) {
+      pendingOld = line.slice(4).trim();
+      continue;
+    }
+    if (line.startsWith('+++ ')) {
+      pendingNew = line.slice(4).trim();
+
+      const oldP = pendingOld ? pendingOld.replace(/^a\//, '').trim() : '';
+      const newP = pendingNew ? pendingNew.replace(/^b\//, '').trim() : '';
+
+      const oldIsDevNull = oldP === '/dev/null';
+      const newIsDevNull = newP === '/dev/null';
+
+      if (!newIsDevNull) {
+        const rel = normalizePatchPath(newP);
+        if (rel && !seen.has(rel)) {
+          seen.add(rel);
+          paths.push(rel);
+        }
+        if (oldIsDevNull) created.add(rel);
+      }
+
+      if (!oldIsDevNull && newIsDevNull) {
+        const rel = normalizePatchPath(oldP);
+        if (rel && !seen.has(rel)) {
+          seen.add(rel);
+          paths.push(rel);
+        }
+        deleted.add(rel);
+      }
+
+      pendingOld = null;
+      pendingNew = null;
+      continue;
+    }
+  }
+
+  return { paths, created, deleted };
+}
+
+async function runCommandWithStdin(
+  cmd: string,
+  cmdArgs: string[],
+  stdinText: string,
+  cwd: string,
+  maxOutBytes: number
+): Promise<{ rc: number; out: string; err: string }> {
+  return await new Promise((resolve, reject) => {
+    const child = spawn(cmd, cmdArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
+
+    const outChunks: Buffer[] = [];
+    const errChunks: Buffer[] = [];
+    let outSeen = 0;
+    let errSeen = 0;
+    let outCaptured = 0;
+    let errCaptured = 0;
+
+    const pushCapped = (chunks: Buffer[], buf: Buffer, kind: 'out' | 'err') => {
+      const n = buf.length;
+      if (kind === 'out') outSeen += n;
+      else errSeen += n;
+
+      const captured = kind === 'out' ? outCaptured : errCaptured;
+      const remaining = maxOutBytes - captured;
+      if (remaining <= 0) return;
+      const take = n <= remaining ? buf : buf.subarray(0, remaining);
+      chunks.push(Buffer.from(take));
+      if (kind === 'out') outCaptured += take.length;
+      else errCaptured += take.length;
+    };
+
+    child.stdout.on('data', (d) => pushCapped(outChunks, Buffer.from(d), 'out'));
+    child.stderr.on('data', (d) => pushCapped(errChunks, Buffer.from(d), 'err'));
+
+    child.on('error', (e: any) => reject(new Error(`${cmd}: ${e?.message ?? String(e)}`)));
+    child.on('close', (code) => {
+      const outRaw = stripAnsi(Buffer.concat(outChunks).toString('utf8'));
+      const errRaw = stripAnsi(Buffer.concat(errChunks).toString('utf8'));
+
+      const outT = truncateBytes(outRaw, maxOutBytes, outSeen);
+      const errT = truncateBytes(errRaw, maxOutBytes, errSeen);
+
+      resolve({ rc: code ?? 0, out: outT.text, err: errT.text });
+    });
+
+    child.stdin.write(String(stdinText ?? ''), 'utf8');
+    child.stdin.end();
+  });
+}
+
+export async function edit_range(ctx: ToolContext, args: any) {
+  const p = resolvePath(ctx, args?.path);
+  const startLine = Number(args?.start_line);
+  const endLine = Number(args?.end_line);
+  const rawReplacement = args?.replacement;
+  const replacement = typeof rawReplacement === 'string' ? rawReplacement
+    : (rawReplacement != null && typeof rawReplacement === 'object' ? JSON.stringify(rawReplacement, null, 2) : undefined);
+
+  if (!p) throw new Error('edit_range: missing path');
+  if (!Number.isFinite(startLine) || startLine < 1) throw new Error('edit_range: missing/invalid start_line');
+  if (!Number.isFinite(endLine) || endLine < startLine) throw new Error('edit_range: missing/invalid end_line');
+  if (replacement == null) throw new Error('edit_range: missing replacement (got ' + typeof rawReplacement + ')');
+
+  // Path safety check (Phase 9)
+  const pathVerdict = checkPathSafety(p);
+  if (pathVerdict.tier === 'forbidden') {
+    throw new Error(`edit_range: ${pathVerdict.reason}`);
+  }
+  if (pathVerdict.tier === 'cautious' && !ctx.noConfirm) {
+    if (ctx.confirm) {
+      const ok = await ctx.confirm(
+        pathVerdict.prompt || `Edit range in ${p}?`,
+        { tool: 'edit_range', args: { path: p, start_line: startLine, end_line: endLine } }
+      );
+      if (!ok) throw new Error(`edit_range: cancelled by user (${pathVerdict.reason})`);
+    } else {
+      throw new Error(`edit_range: blocked (${pathVerdict.reason}) without --no-confirm/--yolo`);
+    }
+  }
+
+  if (ctx.dryRun) return `dry-run: would edit_range ${p} lines ${startLine}-${endLine} (${Buffer.byteLength(replacement, 'utf8')} bytes)`;
+
+  // Phase 9d: snapshot /etc/ files before editing
+  if (ctx.mode === 'sys' && ctx.vault) {
+    await snapshotBeforeEdit(ctx.vault, p).catch(() => {});
+  }
+
+  const beforeText = await fs.readFile(p, 'utf8').catch((e: any) => {
+    throw new Error(`edit_range: cannot read ${p}: ${e?.message ?? String(e)}`);
+  });
+
+  const eol = beforeText.includes('\r\n') ? '\r\n' : '\n';
+  const lines = beforeText.split(/\r?\n/);
+
+  if (startLine > lines.length) {
+    throw new Error(`edit_range: start_line ${startLine} out of range (file has ${lines.length} lines)`);
+  }
+  if (endLine > lines.length) {
+    throw new Error(`edit_range: end_line ${endLine} out of range (file has ${lines.length} lines)`);
+  }
+
+  const startIdx = startLine - 1;
+  const deleteCount = endLine - startLine + 1;
+
+  // For deletion, allow empty replacement to remove the range without leaving a blank line.
+  const replacementLines = replacement === '' ? [] : replacement.split(/\r?\n/);
+  lines.splice(startIdx, deleteCount, ...replacementLines);
+
+  const out = lines.join(eol);
+
+  await backupFile(p, ctx);
+  await atomicWrite(p, out);
+  ctx.onMutation?.(p);
+
+  const replayNote = await checkpointReplay(ctx, {
+    op: 'edit_range',
+    filePath: p,
+    before: Buffer.from(beforeText, 'utf8'),
+    after: Buffer.from(out, 'utf8')
+  });
+
+  const cwdWarning = checkCwdWarning('edit_range', p, ctx);
+  return `edited ${p} lines ${startLine}-${endLine}${replayNote}${cwdWarning}`;
+}
+
+export async function apply_patch(ctx: ToolContext, args: any) {
+  const rawPatch = args?.patch;
+  const patchText = typeof rawPatch === 'string' ? rawPatch
+    : (rawPatch != null && typeof rawPatch === 'object' ? JSON.stringify(rawPatch, null, 2) : undefined);
+
+  const rawFiles = Array.isArray(args?.files) ? args.files : [];
+  const files = rawFiles
+    .map((f: any) => (typeof f === 'string' ? f.trim() : ''))
+    .filter(Boolean);
+
+  const stripRaw = Number(args?.strip);
+  const strip = Number.isFinite(stripRaw) ? Math.max(0, Math.min(5, Math.floor(stripRaw))) : 0;
+
+  if (!patchText) throw new Error('apply_patch: missing patch');
+  if (!files.length) throw new Error('apply_patch: missing files[]');
+
+  const touched = extractTouchedFilesFromPatch(patchText);
+  if (!touched.paths.length) {
+    throw new Error('apply_patch: patch contains no recognizable file headers');
+  }
+
+  const declared = new Set(files.map(normalizePatchPath));
+  const unknown = touched.paths.filter((p) => !declared.has(p));
+  if (unknown.length) {
+    throw new Error(`apply_patch: patch touches undeclared file(s): ${unknown.join(', ')}`);
+  }
+
+  const absPaths = touched.paths.map((rel) => resolvePath(ctx, rel));
+
+  // Path safety check (Phase 9)
+  const verdicts = absPaths.map((p) => ({ p, v: checkPathSafety(p) }));
+  const forbidden = verdicts.filter(({ v }) => v.tier === 'forbidden');
+  if (forbidden.length) {
+    throw new Error(`apply_patch: ${forbidden[0].v.reason} (${forbidden[0].p})`);
+  }
+
+  const cautious = verdicts.filter(({ v }) => v.tier === 'cautious');
+  if (cautious.length && !ctx.noConfirm) {
+    if (ctx.confirm) {
+      const preview = patchText.length > 4000 ? patchText.slice(0, 4000) + '\n[truncated]' : patchText;
+      const ok = await ctx.confirm(
+        `Apply patch touching ${touched.paths.length} file(s)?\n- ${touched.paths.join('\n- ')}\n\nProceed? (y/N) `,
+        { tool: 'apply_patch', args: { files: touched.paths, strip }, diff: preview }
+      );
+      if (!ok) throw new Error('apply_patch: cancelled by user');
+    } else {
+      throw new Error('apply_patch: blocked (cautious paths) without --no-confirm/--yolo');
+    }
+  }
+
+  const maxToolBytes = ctx.maxExecBytes ?? DEFAULT_MAX_EXEC_BYTES;
+  const stripArg = `-p${strip}`;
+
+  // Dry-run: validate the patch applies cleanly, but do not mutate files.
+  if (ctx.dryRun) {
+    const haveGit = !spawnSync('git', ['--version'], { stdio: 'ignore' }).error;
+    if (haveGit) {
+      const chk = await runCommandWithStdin('git', ['apply', stripArg, '--check', '--whitespace=nowarn'], patchText, ctx.cwd, maxToolBytes);
+      if (chk.rc !== 0) throw new Error(`apply_patch: git apply --check failed:\n${chk.err || chk.out}`);
+    } else {
+      const chk = await runCommandWithStdin('patch', [stripArg, '--dry-run', '--batch'], patchText, ctx.cwd, maxToolBytes);
+      if (chk.rc !== 0) throw new Error(`apply_patch: patch --dry-run failed:\n${chk.err || chk.out}`);
+    }
+    return `dry-run: patch would apply cleanly (${touched.paths.length} files): ${touched.paths.join(', ')}`;
+  }
+
+  // Snapshot + backup before applying
+  const beforeMap = new Map<string, Buffer>();
+  for (const abs of absPaths) {
+    // Phase 9d: snapshot /etc/ files before editing
+    if (ctx.mode === 'sys' && ctx.vault) {
+      await snapshotBeforeEdit(ctx.vault, abs).catch(() => {});
+    }
+
+    const before = await fs.readFile(abs).catch(() => Buffer.from(''));
+    beforeMap.set(abs, before);
+    await backupFile(abs, ctx);
+  }
+
+  // Apply with git apply if available; fallback to patch.
+  const haveGit = !spawnSync('git', ['--version'], { stdio: 'ignore' }).error;
+  if (haveGit) {
+    const chk = await runCommandWithStdin('git', ['apply', stripArg, '--check', '--whitespace=nowarn'], patchText, ctx.cwd, maxToolBytes);
+    if (chk.rc !== 0) throw new Error(`apply_patch: git apply --check failed:\n${chk.err || chk.out}`);
+
+    const app = await runCommandWithStdin('git', ['apply', stripArg, '--whitespace=nowarn'], patchText, ctx.cwd, maxToolBytes);
+    if (app.rc !== 0) throw new Error(`apply_patch: git apply failed:\n${app.err || app.out}`);
+  } else {
+    const chk = await runCommandWithStdin('patch', [stripArg, '--dry-run', '--batch'], patchText, ctx.cwd, maxToolBytes);
+    if (chk.rc !== 0) throw new Error(`apply_patch: patch --dry-run failed:\n${chk.err || chk.out}`);
+
+    const app = await runCommandWithStdin('patch', [stripArg, '--batch'], patchText, ctx.cwd, maxToolBytes);
+    if (app.rc !== 0) throw new Error(`apply_patch: patch failed:\n${app.err || app.out}`);
+  }
+
+  // Replay checkpoints + mutation hooks
+  let replayNotes = '';
+  let cwdWarnings = '';
+  for (const abs of absPaths) {
+    const after = await fs.readFile(abs).catch(() => Buffer.from(''));
+    ctx.onMutation?.(abs);
+
+    const replayNote = await checkpointReplay(ctx, {
+      op: 'apply_patch',
+      filePath: abs,
+      before: beforeMap.get(abs) ?? Buffer.from(''),
+      after
+    });
+    replayNotes += replayNote;
+
+    cwdWarnings += checkCwdWarning('apply_patch', abs, ctx);
+  }
+
+  return `applied patch (${touched.paths.length} files): ${touched.paths.join(', ')}${replayNotes}${cwdWarnings}`;
+}
+
 export async function edit_file(ctx: ToolContext, args: any) {
   const p = resolvePath(ctx, args?.path);
   const rawOld = args?.old_text;
```

