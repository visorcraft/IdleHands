export type TuiAction =
  | 'send'
  | 'insert_newline'
  | 'backspace'
  | 'delete_forward'
  | 'cursor_left'
  | 'cursor_right'
  | 'cursor_home'
  | 'cursor_end'
  | 'history_prev'
  | 'history_next'
  | 'cancel'
  | 'quit'
  | 'tab_complete'
  | 'focus_prev'
  | 'scroll_up'
  | 'scroll_down'
  | 'history_search'
  | 'open_step_navigator'
  | 'open_settings';

export function resolveAction(key: string): TuiAction | null {
  switch (key) {
    case 'C-c':
      return 'cancel';
    case 'esc':
      return 'cancel';
    case 'C-d':
      return 'quit';
    case 'C-r':
      return 'history_search';
    case 'C-g':
      return 'open_step_navigator';
    case 'C-o':
      return 'open_settings';
    case 'tab':
      return 'tab_complete';
    case 'S-tab':
      return 'focus_prev';
    case 'pageup':
      return 'scroll_up';
    case 'pagedown':
      return 'scroll_down';
    case 'up':
      return 'history_prev';
    case 'down':
      return 'history_next';
    case 'left':
      return 'cursor_left';
    case 'right':
      return 'cursor_right';
    case 'enter':
      return 'send';
    case 'C-j':
      return 'insert_newline';
    case 'M-enter':
      return 'insert_newline';
    case 'backspace':
      return 'backspace';
    case 'delete':
      return 'delete_forward';
    case 'home':
      return 'cursor_home';
    case 'end':
      return 'cursor_end';
    default:
      return null;
  }
}

export function decodeRawInput(chunk: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!;
    if (ch === '\u001b') {
      const c1 = chunk[i + 1];
      const c2 = chunk[i + 2];
      if (c1 === '[' && c2 === 'A') {
        keys.push('up');
        i += 2;
        continue;
      }
      if (c1 === '[' && c2 === 'B') {
        keys.push('down');
        i += 2;
        continue;
      }
      if (c1 === '[' && c2 === 'C') {
        keys.push('right');
        i += 2;
        continue;
      }
      if (c1 === '[' && c2 === 'D') {
        keys.push('left');
        i += 2;
        continue;
      }
      if (c1 === 'O' && c2 === 'A') {
        keys.push('up');
        i += 2;
        continue;
      }
      if (c1 === 'O' && c2 === 'B') {
        keys.push('down');
        i += 2;
        continue;
      }
      if (c1 === 'O' && c2 === 'C') {
        keys.push('right');
        i += 2;
        continue;
      }
      if (c1 === 'O' && c2 === 'D') {
        keys.push('left');
        i += 2;
        continue;
      }
      // CSI sequences with ~ terminator: \x1b[N~ (PageUp=5~, PageDown=6~, Home=1~, End=4~, Delete=3~)
      if (c1 === '[' && c2 !== undefined) {
        const c3 = chunk[i + 3];
        if (c3 === '~') {
          if (c2 === '5') {
            keys.push('pageup');
            i += 3;
            continue;
          }
          if (c2 === '6') {
            keys.push('pagedown');
            i += 3;
            continue;
          }
          if (c2 === '1') {
            keys.push('home');
            i += 3;
            continue;
          }
          if (c2 === '4') {
            keys.push('end');
            i += 3;
            continue;
          }
          if (c2 === '3') {
            keys.push('delete');
            i += 3;
            continue;
          }
          // Unknown CSI ~-terminated sequence — skip
          i += 3;
          continue;
        }
      }
      if (c1 === '\r') {
        keys.push('M-enter');
        i += 1;
        continue;
      }
      if (c1 === undefined) {
        keys.push('esc');
        continue;
      }
      continue;
    }
    if (ch === '\u0003') {
      keys.push('C-c');
      continue;
    }
    if (ch === '\u0004') {
      keys.push('C-d');
      continue;
    }
    if (ch === '\u0012') {
      keys.push('C-r');
      continue;
    }
    if (ch === '\u0007') {
      keys.push('C-g');
      continue;
    }
    if (ch === '\u000f') {
      keys.push('C-o');
      continue;
    }
    if (ch === '\u0009') {
      keys.push('tab');
      continue;
    }
    if (ch === '\u007f') {
      keys.push('backspace');
      continue;
    }
    if (ch === '\r') {
      keys.push('enter');
      continue;
    }
    if (ch === '\n') {
      keys.push('C-j');
      continue;
    }
    keys.push(`text:${ch}`);
  }
  return keys;
}
