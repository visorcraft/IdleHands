/**
 * Anton autonomous task runner — task file parser and mutators.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import type { AntonTask, AntonTaskFile } from './types.js';

/**
 * Normalize whitespace: collapse all runs to single space, trim.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Generate stable task key using section 6.2 algorithm.
 */
function generateTaskKey(
  phasePath: string[],
  depth: number,
  taskText: string,
  siblingOrdinal: number
): string {
  const input = [
    phasePath.join(' > '),
    String(depth),
    normalizeWhitespace(taskText),
    String(siblingOrdinal)
  ].join(' | ');
  
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Atomic write helper for file mutations.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmp = filePath + '.anton-tmp';
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}

/**
 * Parse task string content into AntonTaskFile.
 */
export function parseTaskString(content: string, filePath: string): AntonTaskFile {
  const lines = content.split('\n');
  const allTasks: AntonTask[] = [];
  const phasePath: string[] = [];
  const taskStack: AntonTask[] = []; // Stack to track parent tasks
  
  let inCodeBlock = false;
  let currentTask: AntonTask | null = null;
  
  // Track sibling ordinals for duplicate text detection
  const siblingCounts = new Map<string, number>(); // "parentKey:depth:normalizedText" -> count
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    
    // Toggle code block state
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    
    // Skip lines inside code blocks
    if (inCodeBlock) {
      continue;
    }
    
    // Handle headings - update phasePath
    const headingMatch = line.match(/^(#+)\s*(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      
      // Update phasePath: replace this level and clear deeper levels
      phasePath.length = level - 1;
      phasePath[level - 1] = title;
      continue;
    }
    
    // Match task lines (both "- [ ]" and "● [ ]" formats)
    const taskMatch = line.match(/^(\s*)(?:-|●) \[([ xX])\] (.+)$/);
    if (taskMatch) {
      const indentStr = taskMatch[1];
      const checkbox = taskMatch[2];
      const text = taskMatch[3].trim();
      
      // Skip empty task text
      if (!text) {
        console.warn(`Warning: Skipping empty task at line ${lineNum}`);
        continue;
      }
      
      // Calculate depth: 2 spaces = 1 level, 1 tab = 1 level
      const depth = indentStr.replace(/\t/g, '  ').length / 2;
      
      // Find parent task
      let parentKey: string | undefined;
      
      // Pop tasks from stack that are not ancestors (same or deeper depth)
      while (taskStack.length > 0 && taskStack[taskStack.length - 1].depth >= depth) {
        taskStack.pop();
      }
      
      // If there's a task on the stack, it's our parent
      if (taskStack.length > 0) {
        parentKey = taskStack[taskStack.length - 1].key;
      }
      
      // Calculate sibling ordinal
      const siblingKey = `${parentKey || 'root'}:${depth}:${normalizeWhitespace(text)}`;
      const siblingOrdinal = siblingCounts.get(siblingKey) || 0;
      siblingCounts.set(siblingKey, siblingOrdinal + 1);
      
      // Generate stable key
      const key = generateTaskKey([...phasePath], depth, text, siblingOrdinal);
      
      // Create task
      const task: AntonTask = {
        key,
        text,
        phasePath: [...phasePath],
        depth,
        line: lineNum,
        checked: checkbox !== ' ',
        parentKey,
        children: []
      };
      
      // Add to parent's children if applicable
      if (parentKey && taskStack.length > 0) {
        taskStack[taskStack.length - 1].children.push(task);
      }
      
      allTasks.push(task);
      taskStack.push(task);
      currentTask = task;
      
    } else if (currentTask && line.match(/^\s/) && !line.trim().startsWith('-')) {
      // Continuation line - append to previous task text
      const continuationText = line.trim();
      if (continuationText) {
        currentTask.text += ' ' + continuationText;
      }
    } else {
      // Non-task, non-continuation line resets current task
      currentTask = null;
    }
  }
  
  // Build root tasks (depth 0)
  const roots = allTasks.filter(task => task.depth === 0);
  
  // Split into pending and completed
  const pending = allTasks.filter(task => !task.checked);
  const completed = allTasks.filter(task => task.checked);
  
  // Generate content hash
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
  
  return {
    filePath,
    allTasks,
    roots,
    pending,
    completed,
    totalCount: allTasks.length,
    contentHash
  };
}

/**
 * Parse task file from disk.
 */
export async function parseTaskFile(filePath: string): Promise<AntonTaskFile> {
  try {
    const content = await readFile(filePath, 'utf8');
    return parseTaskString(content, filePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Task file not found: ${filePath}`);
    }
    throw error;
  }
}

/**
 * Find runnable pending tasks, filtering by skipped keys and parent dependencies.
 */
export function findRunnablePendingTasks(
  taskFile: AntonTaskFile,
  skippedKeys: Set<string>
): AntonTask[] {
  const pendingTasks = taskFile.pending.filter(task => !skippedKeys.has(task.key));
  const pendingKeys = new Set(pendingTasks.map(t => t.key));
  
  return pendingTasks.filter(task => {
    // If task has no parent, it's runnable
    if (!task.parentKey) {
      return true;
    }
    
    // Find parent task
    const parent = taskFile.allTasks.find(t => t.key === task.parentKey);
    if (!parent) {
      return true; // Parent not found, assume runnable
    }
    
    // If parent is checked, child is runnable
    if (parent.checked) {
      return true;
    }
    
    // If parent is unchecked AND pending, child must wait
    if (pendingKeys.has(parent.key)) {
      return false;
    }
    
    // Parent is unchecked but not pending (skipped), child is runnable
    return true;
  });
}

/**
 * Mark a task as checked by replacing [ ] with [x].
 */
export async function markTaskChecked(filePath: string, taskKey: string): Promise<void> {
  const content = await readFile(filePath, 'utf8');
  const taskFile = parseTaskString(content, filePath);
  
  const task = taskFile.allTasks.find(t => t.key === taskKey);
  if (!task) {
    throw new Error(`Task not found: ${taskKey}`);
  }
  
  // If already checked, no-op (idempotent)
  if (task.checked) {
    return;
  }
  
  // Split content into lines and update the specific line
  const lines = content.split('\n');
  const lineIndex = task.line - 1;
  
  if (lineIndex >= 0 && lineIndex < lines.length) {
    const line = lines[lineIndex];
    // Handle both "- [ ]" and "● [ ]" formats
    const updatedLine = line.replace(/(-|●) \[ \]/, (match, bullet) => `${bullet} [x]`);
    lines[lineIndex] = updatedLine;
    
    const newContent = lines.join('\n');
    await atomicWriteFile(filePath, newContent);
  }
}

/**
 * Append a note to a task using HTML comment format.
 */
export async function appendTaskNote(filePath: string, taskKey: string, note: string): Promise<void> {
  const content = await readFile(filePath, 'utf8');
  const taskFile = parseTaskString(content, filePath);
  
  const task = taskFile.allTasks.find(t => t.key === taskKey);
  if (!task) {
    throw new Error(`Task not found: ${taskKey}`);
  }
  
  const noteComment = `<!-- anton: ${note} -->`;
  
  // Check if note already exists (idempotent)
  if (content.includes(noteComment)) {
    return;
  }
  
  // Split content into lines and insert note after task line
  const lines = content.split('\n');
  const lineIndex = task.line - 1;
  
  if (lineIndex >= 0 && lineIndex < lines.length) {
    lines.splice(lineIndex + 1, 0, noteComment);
    
    const newContent = lines.join('\n');
    await atomicWriteFile(filePath, newContent);
  }
}

/**
 * Insert subtasks after a parent task.
 */
export async function insertSubTasks(
  filePath: string,
  parentKey: string,
  items: string[]
): Promise<AntonTask[]> {
  if (items.length === 0) {
    return [];
  }
  
  const content = await readFile(filePath, 'utf8');
  const taskFile = parseTaskString(content, filePath);
  
  const parentTask = taskFile.allTasks.find(t => t.key === parentKey);
  if (!parentTask) {
    throw new Error(`Parent task not found: ${parentKey}`);
  }
  
  // Calculate indentation for subtasks
  const childIndent = '  '.repeat(parentTask.depth + 1);
  
  // Generate subtask lines (support both "- [ ]" and "● [ ]" formats)
  const subtaskLines = items.map(item => `${childIndent}● [ ] ${item}`);
  
  // Split content into lines and insert subtasks
  const lines = content.split('\n');
  const insertIndex = parentTask.line; // Insert after parent line (0-based vs 1-based)
  
  lines.splice(insertIndex, 0, ...subtaskLines);
  
  const newContent = lines.join('\n');
  await atomicWriteFile(filePath, newContent);
  
  // Re-parse to get the new tasks
  const updatedTaskFile = parseTaskString(newContent, filePath);
  
  // Find the newly created subtasks
  const newTasks = updatedTaskFile.allTasks.filter(task => 
    task.parentKey === parentKey && 
    !taskFile.allTasks.some(oldTask => oldTask.key === task.key)
  );
  
  return newTasks;
}

/**
 * Auto-complete ancestor tasks when all children are checked.
 */
export async function autoCompleteAncestors(filePath: string, childKey: string): Promise<string[]> {
  const completedAncestors: string[] = [];
  
  let currentKey = childKey;
  
  while (true) {
    const content = await readFile(filePath, 'utf8');
    const taskFile = parseTaskString(content, filePath);
    
    const currentTask = taskFile.allTasks.find(t => t.key === currentKey);
    if (!currentTask || !currentTask.parentKey) {
      break; // No parent, done
    }
    
    const parent = taskFile.allTasks.find(t => t.key === currentTask.parentKey);
    if (!parent) {
      break; // Parent not found
    }
    
    // If parent is already checked, stop
    if (parent.checked) {
      break;
    }
    
    // Check if ALL children of parent are checked
    const allChildrenChecked = parent.children.every(child => child.checked);
    
    if (allChildrenChecked) {
      // Mark parent as checked
      await markTaskChecked(filePath, parent.key);
      completedAncestors.push(parent.key);
      
      // Continue with parent
      currentKey = parent.key;
    } else {
      // Not all children are checked, stop cascading
      break;
    }
  }
  
  return completedAncestors;
}